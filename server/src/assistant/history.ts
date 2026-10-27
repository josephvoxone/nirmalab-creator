/**
 * Per-project assistant history: `stories/<id>/assistant.json` = `{ turns: Turn[] }`, newest last,
 * the last 50 turns. Chat writes user and assistant turns; MCP (Task 5) writes one assistant turn
 * per mutating call with `source: 'mcp'` and `by` = the token's name. Writes go through the
 * private atomic JSON writer and are serialised per file (in-process).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import type { Estimate } from './actions.js';

export const MAX_TURNS = 50;

export type TurnAttachment = { id: string; url: string; w: number; h: number };
export type TurnChange = { label: string; undoId: string; undone?: boolean };
/** A spending call the model proposed; only the user's POST `{ confirm: id }` runs it. */
export type TurnPending = {
  id: string; name: string; input: Record<string, unknown>; label: string; estimate: Estimate; createdAt: string;
  /** Story revision when the proposal was made; a later change makes it stale. */
  rev?: number;
  /** Set when it was run (or claimed for running); a second use is refused. */
  used?: string;
};
export type Turn = {
  id: string;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: TurnAttachment[];
  changes?: TurnChange[];
  pending?: TurnPending[];
  source?: 'chat' | 'mcp';
  by?: string;
};
export type NewTurn = Omit<Turn, 'id' | 'at'> & { id?: string; at?: string };

export const historyPath = (storyDir: string) => join(storyDir, 'assistant.json');

export function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

const queues = new Map<string, Promise<unknown>>();

/** Serialise read-modify-write of one history file. */
function serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(path, next);
  void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => undefined);
  return next;
}

async function read(path: string): Promise<Turn[]> {
  const raw = (await readPrivateJsonFile(path)) as { turns?: unknown } | undefined;
  return Array.isArray(raw?.turns) ? (raw.turns as Turn[]) : [];
}

/** Read, change and write the turns under the file's queue; `fn` may mutate the array in place. */
export async function updateTurns<T>(storyDir: string, fn: (turns: Turn[]) => T | Promise<T>): Promise<T> {
  const path = historyPath(storyDir);
  return serial(path, async () => {
    const turns = await read(path);
    const out = await fn(turns);
    await writePrivateJsonFile(path, { turns: turns.slice(-MAX_TURNS) });
    return out;
  });
}

/** Oldest first, at most 50. */
export async function listTurns(storyDir: string): Promise<Turn[]> {
  const path = historyPath(storyDir);
  return serial(path, () => read(path));
}

export async function appendTurn(storyDir: string, turn: NewTurn): Promise<Turn> {
  const full: Turn = { ...turn, id: turn.id ?? newTurnId(), at: turn.at ?? new Date().toISOString() };
  await updateTurns(storyDir, turns => { turns.push(full); });
  return full;
}

/** Mark every change chip with this undo id as undone; false when none was found. */
export async function markUndone(storyDir: string, undoId: string): Promise<boolean> {
  return updateTurns(storyDir, turns => {
    let hit = false;
    for (const turn of turns) for (const change of turn.changes ?? []) if (change.undoId === undoId) { change.undone = true; hit = true; }
    return hit;
  });
}

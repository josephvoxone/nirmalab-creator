/**
 * T2 defence in depth (audit 06 §A.4 layer 3): the routes are not the only door. The assistant (actions, chat turn, confirm,
 * attachments) and MCP call the story service directly, so each of them checks `assertOwner` itself: a user id that does not own the
 * project gets the same NOT_FOUND as for a missing one and nothing moves. These tests call the layer WITHOUT the HTTP gate.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, runAction, type ActionContext } from '../src/assistant/actions.js';
import { AssistantError, confirmPending, resolveAttachments, runPending, runTurn, type AssistantDeps } from '../src/assistant/chat.js';
import { appendTurn } from '../src/assistant/history.js';
import type { ChatOutput, TextModel } from '../src/llm/opencode.js';
import { StoryError } from '../src/stories/service.js';
import { bibleBoard, serviceSetup } from './bible-board.js';
import { makePng } from './media-helpers.js';

const OWNER = 'u_owner';
const INTRUDER = 'u_intruder';

const treeHash = (dir: string): string => {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { h.update(`D:${name}`); walk(full); } else { h.update(`F:${name}:`); h.update(readFileSync(full)); }
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
};

async function world() {
  const t = serviceSetup();
  const calls = { chat: 0 };
  const model: TextModel = { configured: async () => true, chat: async (): Promise<ChatOutput> => { calls.chat += 1; return { message: { role: 'assistant', content: 'ok' }, model: 'fake' }; } };
  const mine = await t.service.create(bibleBoard(), { createdBy: OWNER });
  const dir = t.service.storyDir(mine.id);
  mkdirSync(join(dir, 'uploads'), { recursive: true });
  makePng(join(dir, 'uploads', 'up_0123456789abcdef.png'), 32, 32);
  const rev = (await t.service.get(mine.id))!.rev;
  await appendTurn(dir, { role: 'assistant', text: 'usul', source: 'chat', pending: [{ id: 'p_owner', name: 'render', input: {}, label: 'Render semua', estimate: {} as never, createdAt: new Date().toISOString(), rev }] });
  const deps: AssistantDeps = { stories: t.service, model };
  const ctx = (userId: string): ActionContext => ({ stories: t.service, snapshots: t.service.snapshots, userId, source: 'chat', turn: {}, model });
  return { ...t, mine, dir, deps, calls, ctx };
}

const expectNotFound = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, e => e as Error);
  expect(error, 'harus ditolak').toBeDefined();
  const ok = (error instanceof StoryError && error.code === 'NOT_FOUND') || (error instanceof AssistantError && error.status === 404);
  expect(ok, `ditolak sebagai NOT_FOUND, bukan: ${error?.name} ${error?.message}`).toBe(true);
};

describe('T2 assistant service layer: assertOwner without the HTTP gate', () => {
  it('every action answers a non-owner NOT_FOUND (ok:false) and moves nothing; the owner still gets a real answer', async () => {
    const w = await world();
    const before = treeHash(join(w.dataDir, 'stories'));
    const wrong: string[] = [];
    for (const name of ACTION_NAMES) {
      const result = await runAction({ ...w.ctx(INTRUDER), confirmed: true }, w.mine.id, name, {});
      if (result.ok || ('needsConfirm' in result) || result.code !== 'NOT_FOUND') wrong.push(`${name}: ${JSON.stringify(result).slice(0, 100)}`);
    }
    expect(wrong).toEqual([]);
    expect(treeHash(join(w.dataDir, 'stories'))).toBe(before);
    const own = await runAction(w.ctx(OWNER), w.mine.id, 'get_project', {});
    expect(own.ok).toBe(true);
  });

  it('runTurn refuses a non-owner before writing a turn or calling the model', async () => {
    const w = await world();
    const before = treeHash(join(w.dataDir, 'stories'));
    await expectNotFound(runTurn(w.deps, { storyId: w.mine.id, userId: INTRUDER, message: 'ubah judulnya', attachments: [], signal: new AbortController().signal }, () => undefined));
    expect(w.calls.chat).toBe(0);
    expect(treeHash(join(w.dataDir, 'stories'))).toBe(before);
  });

  it('confirmPending and runPending refuse a non-owner: the owner\'s approval is neither claimed nor run', async () => {
    const w = await world();
    const before = treeHash(join(w.dataDir, 'stories'));
    await expectNotFound(confirmPending(w.deps, { storyId: w.mine.id, userId: INTRUDER, pendingId: 'p_owner' }));
    const pending = { id: 'p_owner', name: 'render' as const, input: {}, label: 'Render semua', estimate: {} as never, createdAt: new Date().toISOString() };
    await expectNotFound(runPending(w.deps, { storyId: w.mine.id, userId: INTRUDER, pending }, () => undefined));
    expect(treeHash(join(w.dataDir, 'stories'))).toBe(before);
    expect(await w.flow.listJobs()).toHaveLength(0);
  });

  it('resolveAttachments refuses a non-owner (even for an upload id that exists) and accepts the owner', async () => {
    const w = await world();
    await expectNotFound(resolveAttachments(w.service, w.mine.id, ['up_0123456789abcdef'], INTRUDER));
    const ok = await resolveAttachments(w.service, w.mine.id, ['up_0123456789abcdef'], OWNER);
    expect(ok.map(a => a.id)).toEqual(['up_0123456789abcdef']);
  });
});

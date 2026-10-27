/**
 * Project assistant chat (spec §6.3): one user message = one turn = one tool loop over the action
 * layer, streamed as events (`turn`, `step`, `change`, `pending`, `delta`, `error`, `done`).
 *
 * Rules that make it safe:
 * - The model never confirms spending. A spending action answers `needsConfirm`; the turn stores a
 *   pending entry and the model is told the button is shown. Only the user's POST `{ confirm: id }`
 *   runs that stored name+input with `ctx.confirmed = true` (`claimPending` + `runPending`).
 * - At most `MAX_STEPS` model calls and `TURN_MS` per turn; the caller's signal (client
 *   disconnect) aborts the model call.
 * - One turn = one `ActionContext.turn` (one undo id); changes are reported with that undo id.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoryError, type StoryService } from '../stories/service.js';
import type { Storyboard } from '../stories/storyboard.js';
import { LlmError, type ChatMessage, type TextModel, type ToolCall } from '../llm/opencode.js';
import { ACTION_NAMES, ACTIONS, BUSY_MESSAGE, runAction, toolSpecs, type ActionContext, type ActionResult } from './actions.js';
import { appendTurn, listTurns, markUndone, newTurnId, updateTurns, type Turn, type TurnAttachment, type TurnChange, type TurnPending } from './history.js';
import { rangeText, resolveCharacter, resolveLocation, resolveScene, resolveShot, sceneIds, shotIds } from './resolve.js';
import { skillsPrompt } from './skills.js';
import { findUpload, imageInfo, uploadsDir } from './uploads.js';

export const MAX_STEPS = 6;
export const TURN_MS = 90_000;
export const MODEL_CALL_MS = 60_000;
export const TOOL_RESULT_MAX = 4000;
export const CONTEXT_TURNS = 12;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_ATTACHMENTS = 4;
export const PENDING_TTL_MS = 30 * 60_000;

export const CONFIRM_TOOL_TEXT = 'Butuh persetujuan pengguna; tombol Jalankan sudah ditampilkan. Jangan panggil lagi.';
export const NOT_CONFIGURED_MESSAGE = 'Asisten butuh model teks — atur di Pengaturan › Provider.';
export const TURN_BUSY_MESSAGE = 'Asisten masih menjawab';
export const PENDING_STALE_MESSAGE = 'Proyek sudah berubah — minta ulang';
export const PENDING_EXPIRED_MESSAGE = 'Persetujuan sudah kedaluwarsa (30 menit) — minta ulang';
export const PENDING_USED_MESSAGE = 'Sudah dijalankan — minta ulang kalau perlu lagi';
export const PENDING_MISSING_MESSAGE = 'Persetujuan itu tidak ditemukan';
export const TIMEOUT_MESSAGE = 'Asisten kehabisan waktu (90 dtk). Perubahan yang sudah tampil tetap tersimpan; coba permintaan yang lebih kecil.';
export const CANCELLED_MESSAGE = 'Dibatalkan.';
export const ATTACHMENT_MISSING_MESSAGE = 'Lampiran tidak ditemukan di proyek ini — unggah ulang gambarnya.';

export type AssistantEvent = 'turn' | 'step' | 'delta' | 'change' | 'pending' | 'error' | 'done';
export type Emit = (event: AssistantEvent, data: Record<string, unknown>) => void;

export type AssistantDeps = {
  stories: StoryService;
  model?: TextModel;
  price?: ActionContext['price'];
  /** Whole-turn limit; default `TURN_MS`. */
  totalMs?: number;
};

/** A refusal before any streaming starts (→ plain HTTP error). */
export class AssistantError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AssistantError';
  }
}

// ------------------------------------------------------------------ helpers

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

/** JSON of a tool result for the model, at most `TOOL_RESULT_MAX` chars. */
function toolText(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > TOOL_RESULT_MAX ? `${s.slice(0, TOOL_RESULT_MAX - 12)} …[dipotong]` : s;
}

/** Sentence-sized pieces (≤ ~40 chars) whose concatenation is exactly `text`. */
export function deltaChunks(text: string, max = 40): string[] {
  const out: string[] = [];
  const sentences = text.match(/[^.!?\n]*(?:[.!?]+|\n+|$)[^\S\n]*/g)?.filter(Boolean) ?? [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > max) {
      const space = rest.lastIndexOf(' ', max);
      const cut = space > 0 ? space + 1 : max;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
  }
  return out.join('') === text ? out : [text];
}

const attachmentLine = (a: TurnAttachment, i: number) => `lampiran ${i + 1}: gambar ${a.w}x${a.h}, id ${a.id}`;

/** A stored turn as plain text for the model's context (no tool traffic). */
function renderTurn(turn: Turn): ChatMessage {
  if (turn.role === 'user') {
    const lines = [turn.text, ...(turn.attachments ?? []).map(attachmentLine)].filter(Boolean);
    return { role: 'user', content: lines.join('\n') };
  }
  const head = turn.source === 'mcp' ? `MCP · ${turn.by ?? 'klien'}: ` : '';
  const lines = [`${head}${turn.text}`];
  for (const c of turn.changes ?? []) lines.push(`[Diubah: ${c.label}${c.undone ? ' — sudah dibatalkan' : ''}]`);
  for (const p of turn.pending ?? []) lines.push(`[${p.used ? 'Dijalankan pengguna' : 'Menunggu persetujuan'}: ${p.label}]`);
  return { role: 'assistant', content: lines.join('\n') };
}

/** Indonesian step line for a tool call, with the target resolved on this board. */
export function stepLabel(board: Storyboard, name: string, input: Record<string, unknown>): string {
  const shot = (key = 'shot') => {
    const v = input[key];
    if (typeof v !== 'number' && typeof v !== 'string') return '';
    const r = resolveShot(board, v);
    return 'error' in r ? String(v) : String(r.n);
  };
  const scene = (key = 'scene') => {
    const v = input[key];
    if (typeof v !== 'number' && typeof v !== 'string') return '';
    const r = resolveScene(board, v);
    return 'error' in r ? String(v) : String(r.n);
  };
  const character = () => {
    const r = resolveCharacter(board, input.token);
    return 'error' in r ? String(input.token ?? '') : r.token;
  };
  const location = () => {
    const r = resolveLocation(board, input.location);
    return 'error' in r ? String(input.location ?? '') : r.key;
  };
  switch (name) {
    case 'get_project': return 'Membaca proyek';
    case 'edit_shot': return `Mengubah shot ${shot()}`;
    case 'add_shot': return scene() ? `Menambah shot di scene ${scene()}` : 'Menambah shot';
    case 'remove_shot': return `Menghapus shot ${shot()}`;
    case 'move_shot': return `Memindah shot ${shot()}`;
    case 'breakdown_scene': return `Memecah scene ${scene()}${typeof input.count === 'number' ? ` jadi ${input.count} shot` : ' jadi shot'}`;
    case 'edit_scene': return `Mengubah scene ${scene()}`;
    case 'add_scene': return 'Menambah scene';
    case 'remove_scene': return `Menghapus scene ${scene()}`;
    case 'edit_character': return `Mengubah karakter ${character()}`;
    case 'add_character': return `Menambah karakter ${String(input.name ?? input.token ?? '')}`.trim();
    case 'edit_location': return `Mengubah lokasi ${location()}`;
    case 'add_location': return `Menambah lokasi ${String(input.name ?? input.key ?? '')}`.trim();
    case 'set_look': return 'Mengganti look';
    case 'make_sheet': return `Membuat sheet ${character()}`;
    case 'redraw_frame': return `Menggambar ulang keyframe shot ${shot()}`;
    case 'prepare': return scene() ? `Menyiapkan keyframe scene ${scene()}` : 'Menyiapkan keyframe';
    case 'render': return shot() ? `Merender shot ${shot()}` : scene() ? `Merender scene ${scene()}` : 'Merender semua shot';
    case 'assemble': return 'Merakit video';
    case 'undo_last': return 'Membatalkan perubahan terakhir';
    default: return name;
  }
}

function systemPrompt(board: Storyboard, summary: unknown): string {
  const shots = shotIds(board).length;
  const scenes = sceneIds(board).length;
  const bible = !!board.bible;
  return [
    `Kamu asisten untuk satu proyek video di Nirmalab Creator: "${board.title}". Kamu hanya bekerja di proyek ini, lewat aksi (tools) yang tersedia. Jawab dalam Bahasa Indonesia, singkat: satu baris per perubahan.`,
    '',
    '## Aturan',
    `- Sebut shot dan scene dengan nomor yang tampil di aplikasi (shot ${rangeText(shots)}, scene ${rangeText(scenes)}) dan pakai nomor itu saat memanggil aksi.`,
    bible
      ? '- Proyek ini punya bible: ubah niat shot (subject, action, startState, endState, emotion, framing, move, narasi). Jangan pernah menulis teks prompt; aplikasi yang menyusun prompt dari niat.'
      : '- Proyek ini belum punya bible: isi shot boleh ditulis ulang sebagai prompt prosa bahasa Inggris, hanya untuk shot yang diminta. Jangan mengubah proyek menjadi bible.',
    '- Aksi yang memakai kredit Flow atau biaya OpenRouter (render, prepare, make_sheet, redraw_frame, assemble) hanya memberi perkiraan biaya. Pengguna menyetujuinya sendiri dengan tombol Jalankan di aplikasi; jangan panggil aksi itu lagi dan jangan bilang sudah dijalankan.',
    '- Jangan mengarang hasil, angka, atau status. Laporkan hanya yang dikembalikan aksi; kalau aksi gagal, sebut alasannya dan satu hal yang bisa dilakukan pengguna.',
    '- Lampiran pengguna muncul sebagai baris "lampiran N: gambar WxH, id up_…". Id itu boleh dipakai sebagai reference (edit_character, redraw_frame) atau startFrame (add_shot). Kamu tidak bisa melihat isi gambarnya.',
    '',
    '## Ringkasan proyek (get_project)',
    `Proyek ini punya ${shots} shot dan ${scenes} scene.`,
    JSON.stringify(summary),
    '',
    '## Skills',
    skillsPrompt()
  ].join('\n');
}

/** The model call, or a rejection as soon as `signal` aborts (a client that ignores the signal cannot hold the turn). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LlmError('UNAVAILABLE', CANCELLED_MESSAGE));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmError('UNAVAILABLE', CANCELLED_MESSAGE));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const tooBusy = (error: unknown) => error instanceof StoryError && error.code === 'BUSY';

async function currentRev(stories: StoryService, storyId: string): Promise<number> {
  return (await stories.get(storyId))?.rev ?? 0;
}

function contextFor(deps: AssistantDeps, userId: string, confirmed = false): ActionContext {
  return {
    stories: deps.stories, snapshots: deps.stories.snapshots, userId, source: 'chat', turn: {},
    ...(deps.model ? { model: deps.model } : {}), ...(deps.price ? { price: deps.price } : {}),
    ...(confirmed ? { confirmed: true } : {})
  };
}

// ------------------------------------------------------------------ attachments

/** Upload ids of this story → turn attachments; anything unknown is a 400. */
export async function resolveAttachments(stories: StoryService, storyId: string, ids: unknown): Promise<TurnAttachment[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new AssistantError(400, 'INVALID', 'attachments harus daftar id unggahan');
  if (ids.length > MAX_ATTACHMENTS) throw new AssistantError(400, 'INVALID', `Maksimal ${MAX_ATTACHMENTS} lampiran per pesan`);
  const dir = stories.storyDir(storyId);
  const out: TurnAttachment[] = [];
  for (const id of ids as string[]) {
    const file = findUpload(dir, id);
    if (!file) throw new AssistantError(400, 'INVALID', ATTACHMENT_MISSING_MESSAGE);
    const info = imageInfo(await readFile(join(uploadsDir(dir), file)));
    if (!info) throw new AssistantError(400, 'INVALID', ATTACHMENT_MISSING_MESSAGE);
    out.push({ id: file.replace(/\.[a-z]+$/, ''), url: `/api/stories/${storyId}/uploads/${file}`, w: info.w, h: info.h });
  }
  return out;
}

// ------------------------------------------------------------------ one chat turn

export type TurnRequest = { storyId: string; userId: string; message: string; attachments: TurnAttachment[]; signal: AbortSignal };

/**
 * Run one user message. Never throws for model/action trouble: it emits `error` and still ends
 * with `done`, and both the user turn and an assistant turn are saved.
 */
export async function runTurn(deps: AssistantDeps, req: TurnRequest, emit: Emit): Promise<void> {
  const { stories, model } = deps;
  const storyId = req.storyId;
  const dir = stories.storyDir(storyId);
  const earlier = await listTurns(dir);
  await appendTurn(dir, { role: 'user', text: req.message, ...(req.attachments.length ? { attachments: req.attachments } : {}), source: 'chat' });
  const turnId = newTurnId();
  emit('turn', { id: turnId });

  const changes: TurnChange[] = [];
  const pending: TurnPending[] = [];
  let text = '';
  let failure: { message: string; code?: string } | undefined;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deps.totalMs ?? TURN_MS);
  const onAbort = () => controller.abort();
  if (req.signal.aborted) controller.abort();
  else req.signal.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();

  try {
    if (!model || !(await model.configured())) throw new LlmError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
    const ctx = contextFor(deps, req.userId);
    const board0 = await stories.readStoryboard(storyId);
    const summary = await ACTIONS.get_project.run(ctx, storyId, {});
    const userContent = [req.message, ...req.attachments.map(attachmentLine)].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(board0, summary.ok ? summary.data : summary) },
      ...earlier.slice(-CONTEXT_TURNS).map(renderTurn),
      { role: 'user', content: userContent }
    ];
    const tools = toolSpecs();
    let finished = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (controller.signal.aborted) throw new LlmError('UNAVAILABLE', CANCELLED_MESSAGE);
      const left = (deps.totalMs ?? TURN_MS) - (Date.now() - started);
      const out = await untilAborted(
        model.chat({ messages, tools, signal: controller.signal, maxTokens: 2048, timeoutMs: Math.max(1000, Math.min(MODEL_CALL_MS, left)) }),
        controller.signal
      );
      const calls = out.message.tool_calls ?? [];
      if (!calls.length) { text = out.message.content.trim(); finished = true; break; }
      messages.push({ role: 'assistant', content: out.message.content ?? '', tool_calls: calls });
      for (const call of calls) {
        if (controller.signal.aborted) throw new LlmError('UNAVAILABLE', CANCELLED_MESSAGE);
        messages.push({ role: 'tool', tool_call_id: call.id, content: await runToolCall(deps, ctx, storyId, call, emit, changes, pending) });
      }
    }
    if (!finished) {
      text = `Saya berhenti setelah ${MAX_STEPS} langkah. ${changes.length ? 'Perubahan di atas sudah tersimpan.' : 'Belum ada yang diubah.'} Coba permintaan yang lebih spesifik.`;
    } else if (!text) {
      text = changes.length ? changes.map(c => c.label).join('\n') : pending.length ? 'Perlu persetujuan — tekan Jalankan.' : 'Selesai.';
    }
  } catch (error) {
    if (timedOut) failure = { message: TIMEOUT_MESSAGE, code: 'TIMEOUT' };
    else if (req.signal.aborted) failure = { message: CANCELLED_MESSAGE, code: 'CANCELLED' };
    else if (error instanceof LlmError) failure = { message: error.code === 'NOT_CONFIGURED' ? NOT_CONFIGURED_MESSAGE : error.message, code: error.code };
    else failure = { message: `Asisten gagal: ${clip(error instanceof Error ? error.message : String(error), 200)}`, code: 'FAILED' };
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
  }

  if (failure) {
    emit('error', failure);
    text = failure.message;
  } else {
    for (const piece of deltaChunks(text)) emit('delta', { text: piece });
  }
  const rev = await currentRev(stories, storyId);
  for (const p of pending) p.rev = rev;
  await appendTurn(dir, {
    id: turnId, role: 'assistant', text, source: 'chat',
    ...(changes.length ? { changes } : {}), ...(pending.length ? { pending } : {})
  });
  emit('done', { rev });
}

/** One tool call of the model: run it (never confirmed), emit step/change/pending, return the tool result text. */
async function runToolCall(
  deps: AssistantDeps, ctx: ActionContext, storyId: string, call: ToolCall, emit: Emit, changes: TurnChange[], pending: TurnPending[]
): Promise<string> {
  const name = call.function.name;
  if (!(ACTION_NAMES as readonly string[]).includes(name)) return toolText({ ok: false, error: `Aksi "${clip(name, 40)}" tidak ada.` });
  let args: unknown;
  try {
    args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
  } catch {
    return toolText({ ok: false, error: 'Argumen tool bukan JSON yang valid; kirim objek JSON.' });
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolText({ ok: false, error: 'Argumen tool harus objek JSON.' });
  // A `confirm` the model wrote means nothing (runAction strips it too); never stored on a pending entry.
  const { confirm: _ignored, ...input } = args as Record<string, unknown>;

  const board = await deps.stories.readStoryboard(storyId);
  emit('step', { label: stepLabel(board, name, input) });

  const undone = name === 'undo_last' ? (await deps.stories.snapshots.list(storyId)).find(s => typeof s.revAfter === 'number')?.undoId : undefined;
  const revBefore = ctx.turn.rev;
  let result: ActionResult;
  try {
    result = await runAction(ctx, storyId, name, input);
  } catch (error) {
    result = { ok: false, error: tooBusy(error) ? BUSY_MESSAGE : `Gagal: ${clip(error instanceof Error ? error.message : String(error), 200)}` };
  }

  if ('needsConfirm' in result) {
    const key = JSON.stringify([name, input]);
    if (!pending.some(p => JSON.stringify([p.name, p.input]) === key)) {
      const entry: TurnPending = { id: `p_${randomBytes(8).toString('hex')}`, name, input, label: result.label, estimate: result.estimate, createdAt: new Date().toISOString() };
      pending.push(entry);
      emit('pending', { id: entry.id, label: entry.label, estimate: entry.estimate });
    }
    return CONFIRM_TOOL_TEXT;
  }
  if (result.ok) {
    if (undone) {
      for (const c of changes) if (c.undoId === undone) c.undone = true;
      await markUndone(deps.stories.storyDir(storyId), undone);
    }
    if (ctx.turn.undoId && ctx.turn.rev !== revBefore && result.changed !== false) {
      const change = { label: result.label, undoId: ctx.turn.undoId };
      changes.push(change);
      emit('change', change);
    }
  }
  return toolText(result);
}

// ------------------------------------------------------------------ confirming a pending call

/**
 * Take a pending entry for running: refuses unknown (404), used, expired or stale (409) entries,
 * and marks it used before returning it, so a double click cannot run it twice.
 */
export async function claimPending(stories: StoryService, storyId: string, pendingId: string, clientRev?: number): Promise<TurnPending> {
  const rev = await currentRev(stories, storyId);
  return updateTurns(stories.storyDir(storyId), turns => {
    const entry = turns.flatMap(t => t.pending ?? []).find(p => p.id === pendingId);
    if (!entry) throw new AssistantError(404, 'NOT_FOUND', PENDING_MISSING_MESSAGE);
    if (entry.used) throw new AssistantError(409, 'USED', PENDING_USED_MESSAGE);
    if (Date.now() - Date.parse(entry.createdAt) > PENDING_TTL_MS || !Number.isFinite(Date.parse(entry.createdAt))) throw new AssistantError(409, 'EXPIRED', PENDING_EXPIRED_MESSAGE);
    if (entry.rev !== rev || (typeof clientRev === 'number' && clientRev !== rev)) throw new AssistantError(409, 'STALE', PENDING_STALE_MESSAGE);
    entry.used = new Date().toISOString();
    return { ...entry, input: { ...entry.input } };
  });
}

/** Run a claimed pending call with the user's confirmation; the model is not asked again. */
export async function runPending(deps: AssistantDeps, req: { storyId: string; userId: string; pending: TurnPending }, emit: Emit): Promise<void> {
  const { stories } = deps;
  const { storyId, pending } = req;
  const dir = stories.storyDir(storyId);
  await appendTurn(dir, { role: 'user', text: `Jalankan: ${pending.label}`, source: 'chat' });
  const turnId = newTurnId();
  emit('turn', { id: turnId });
  const ctx = contextFor(deps, req.userId, true);
  const changes: TurnChange[] = [];
  let text: string;
  try {
    const board = await stories.readStoryboard(storyId);
    emit('step', { label: stepLabel(board, pending.name, pending.input) });
    const result = await runAction(ctx, storyId, pending.name, pending.input);
    if (result.ok) {
      text = result.label;
      if (ctx.turn.undoId && result.changed !== false) {
        const change = { label: result.label, undoId: ctx.turn.undoId };
        changes.push(change);
        emit('change', change);
      }
      for (const piece of deltaChunks(text)) emit('delta', { text: piece });
    } else {
      text = 'needsConfirm' in result ? 'Aksi ini masih minta persetujuan — minta ulang.' : result.error;
      emit('error', { message: text, ...('code' in result && result.code ? { code: result.code } : {}) });
    }
  } catch (error) {
    text = tooBusy(error) ? BUSY_MESSAGE : `Gagal: ${clip(error instanceof Error ? error.message : String(error), 200)}`;
    emit('error', { message: text });
  }
  await appendTurn(dir, { id: turnId, role: 'assistant', text, source: 'chat', ...(changes.length ? { changes } : {}) });
  emit('done', { rev: await currentRev(stories, storyId) });
}

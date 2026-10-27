/**
 * The project assistant API (server/src/assistant/routes.ts) and the small pure helpers the
 * panel shows: estimate text, the `/` mention list, the empty-state suggestions.
 */
import { requestJson, post, type FetchLike } from '../../lib/api.js';
import type { MentionItem } from '../../ui/MentionTextarea.js';
import type { Story, Upload } from '../stories/storiesClient.js';
import { storiesApi } from '../stories/storiesClient.js';
import type { Board } from '../project/model.js';
import { postSse, type SseEvent } from './sse.js';

export type Estimate = { credits?: number; usd?: number };
export type TurnAttachment = { id: string; url: string; w: number; h: number };
export type TurnChange = { label: string; undoId: string; undone?: boolean };
export type TurnPending = { id: string; label: string; estimate: Estimate; createdAt?: string; used?: string; superseded?: boolean; name?: string; rev?: number };
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
export type History = { turns: Turn[]; configured: boolean };
export type SendBody = { message: string; attachments?: string[] } | { confirm: string };

/** Server words for a pending that can no longer run (used, expired, stale, cost moved, gone). */
export const FINAL_CONFIRM_CODES = new Set(['USED', 'EXPIRED', 'STALE', 'COST_CHANGED', 'NOT_FOUND']);
/** Pendings older than this are refused by the server (`EXPIRED`). */
export const PENDING_TTL_MS = 30 * 60 * 1000;
export const NOT_CONFIGURED = 'NOT_CONFIGURED';
export const MAX_ATTACHMENTS = 4;

/**
 * An uploaded image at a width the server resizes to (`THUMB_WIDTHS` in server/src/media/images.ts:
 * 64, 96, 160, 320, 480, 720, 1080); any other width is refused with a 400.
 */
export const sizedUrl = (url: string, w: 64 | 96 | 160 | 320 | 480 | 720 | 1080) => `${url}${url.includes('?') ? '&' : '?'}w=${w}`;
/** The 64 px thumbnail and its denser variants. */
export const thumbProps = (url: string) => ({ src: sizedUrl(url, 64), srcSet: `${sizedUrl(url, 96)} 1.5x, ${sizedUrl(url, 160)} 2x` });
/** The preview dialog: the largest served width, never the original. */
export const PREVIEW_WIDTH = 1080;

export function assistantApi(fetchImpl: FetchLike) {
  const base = (id: string) => `/api/stories/${id}/assistant`;
  return {
    history: (id: string) => requestJson<History>(fetchImpl, base(id)),
    send: (id: string, body: SendBody, onEvent: (e: SseEvent) => void, signal?: AbortSignal) => postSse(fetchImpl, base(id), body, onEvent, signal),
    undo: (id: string, undoId: string) => requestJson<{ ok: boolean; rev: number }>(fetchImpl, `${base(id)}/undo/${encodeURIComponent(undoId)}`, post({})),
    upload: (id: string, file: Blob, signal?: AbortSignal) => storiesApi(fetchImpl).upload(id, file, signal) as Promise<Upload>
  };
}

const idNumber = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "±40 kredit Flow", "≈ $0,42", "gratis", or "biaya belum diketahui". */
export function estimateText(e: Estimate | undefined): string {
  if (e && typeof e.usd === 'number' && e.usd > 0) return `≈ $${idNumber.format(e.usd)}`;
  if (e && typeof e.credits === 'number' && e.credits > 0) return `±${e.credits} kredit Flow`;
  if (e && (e.credits === 0 || e.usd === 0)) return 'gratis';
  return 'biaya belum diketahui';
}

/** `/` items: every shot ("Shot 3 · scene title" → "shot 3") then every scene ("Scene 2 · title" → "scene 2"). */
export function slashItems(board: Board): MentionItem[] {
  const scenes = board.scenes ?? [];
  const sceneOf = new Map<string, string>();
  for (const s of scenes) for (const id of s.shots) sceneOf.set(id, s.title);
  const shots = board.shots.map((s, i) => ({
    id: `shot-${s.id}`, label: `Shot ${i + 1}${sceneOf.get(s.id) ? ` · ${sceneOf.get(s.id)}` : ''}`, insert: `shot ${i + 1}`
  }));
  const sceneItems = scenes.map((s, i) => ({ id: `scene-${s.id}`, label: `Scene ${i + 1} · ${s.title}`, insert: `scene ${i + 1}` }));
  return [...shots, ...sceneItems];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The first character's display name: bible card first, else the cast map. */
export function firstCharacterName(board: Board): string | undefined {
  const cards = (board.bible as { characters?: Array<{ name?: unknown; token?: unknown }> } | undefined)?.characters;
  if (Array.isArray(cards)) {
    const c = cards.find(x => str(x?.name) || str(x?.token));
    if (c) return str(c.name) || str(c.token);
  }
  const entry = Object.entries(board.characters ?? {})[0];
  if (!entry) return undefined;
  const [token, spec] = entry;
  return typeof spec === 'object' && spec?.name ? spec.name : token;
}

/** Three example instructions built from the real project; general questions fill the gaps. */
export function suggestions(board: Board, story?: Story): string[] {
  const out: string[] = [];
  const name = firstCharacterName(board);
  if (board.bible && (board.scenes?.length ?? 0) > 0) out.push('Pecah scene 1 jadi 4 shot');
  if (board.shots.length >= 2 && name) out.push(`Di shot 2, buat ${name} lebih lega`);
  if ((story?.mode ?? board.mode) === 'konsisten' && name) out.push(`Buat sheet untuk ${name}`);
  for (const fallback of ['Ringkas proyek ini', 'Apa langkah berikutnya?']) if (out.length < 3) out.push(fallback);
  return out.slice(0, 3);
}

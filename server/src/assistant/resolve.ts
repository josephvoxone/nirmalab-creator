/**
 * Turns what a person (or a model) says — "shot 3", "scene 2", "Laras", "keyframe shot 2" — into
 * ids of ONE story. Every lookup reads only the board it is given, so a number or an id from
 * another project can never resolve. Unknown references return a plain Indonesian error that
 * lists what exists ("Shot yang ada: 1–12.").
 *
 * Numbering is what the UI shows: shots 1..N across scenes in board order, scenes 1..M.
 */
import { normalizeScenes, type CharacterSpec, type Storyboard } from '../stories/storyboard.js';
import type { CharacterCard } from '../bible/story.js';
import { copyToUploads, findUpload } from './uploads.js';

export type Ref = number | string;
export type Resolved = { id: string; n: number } | { error: string };

export const rangeText = (count: number) => (count <= 0 ? 'belum ada' : count === 1 ? '1' : `1–${count}`);

/** 3, "3", "shot 3", "#3", "scene 2" → the number; anything else → undefined. */
function numberOf(ref: Ref, word: string): number | undefined {
  if (typeof ref === 'number') return Number.isInteger(ref) ? ref : undefined;
  const m = new RegExp(`^(?:${word}\\s*|#\\s*)?(\\d{1,4})$`, 'i').exec(ref.trim());
  return m ? Number(m[1]) : undefined;
}

function resolveIn(ids: string[], ref: unknown, label: 'Shot' | 'Scene'): Resolved {
  const valid = `${label} yang ada: ${rangeText(ids.length)}.`;
  if (typeof ref !== 'number' && typeof ref !== 'string') return { error: `Sebut nomor ${label.toLowerCase()} (mis. 2). ${valid}` };
  const n = numberOf(ref, label.toLowerCase());
  if (n !== undefined) return n >= 1 && n <= ids.length ? { id: ids[n - 1]!, n } : { error: `${label} ${n} tidak ada. ${valid}` };
  if (typeof ref === 'number') return { error: `${label} ${ref} tidak ada. ${valid}` };
  const at = ids.indexOf(ref.trim());
  return at >= 0 ? { id: ids[at]!, n: at + 1 } : { error: `${label} "${ref.trim().slice(0, 40)}" tidak ada. ${valid}` };
}

/** Shot ids in the order the UI numbers them. */
export const shotIds = (board: Storyboard): string[] => normalizeScenes(board).shots.map(s => s.id);
export const sceneIds = (board: Storyboard): string[] => normalizeScenes(board).scenes!.map(s => s.id);

export function resolveShot(board: Storyboard, ref: Ref): Resolved {
  return resolveIn(shotIds(board), ref, 'Shot');
}

export function resolveScene(board: Storyboard, ref: Ref): Resolved {
  return resolveIn(sceneIds(board), ref, 'Scene');
}

/** Global number of a shot id (1-based), 0 when absent. */
export const shotNumber = (board: Storyboard, id: string) => shotIds(board).indexOf(id) + 1;
export const sceneNumber = (board: Storyboard, id: string) => sceneIds(board).indexOf(id) + 1;

export type ResolvedCharacter = { token: string; name: string; card?: CharacterCard; spec?: CharacterSpec } | { error: string };

const specName = (token: string, spec: CharacterSpec | undefined) =>
  spec && typeof spec === 'object' && spec.name ? spec.name : token.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** A character by TOKEN or name (any case), from the bible cards and the cast map of this board. */
export function resolveCharacter(board: Storyboard, ref: unknown): ResolvedCharacter {
  const tokens = new Set<string>([...(board.bible?.characters ?? []).map(c => c.token), ...Object.keys(board.characters ?? {})]);
  const all = [...tokens].map(token => {
    const card = board.bible?.characters.find(c => c.token === token);
    const spec = board.characters?.[token];
    return { token, name: card?.name ?? specName(token, spec), card, spec };
  });
  const list = all.length ? all.map(c => (c.name.toUpperCase() === c.token ? c.token : `${c.token} (${c.name})`)).join(', ') : 'belum ada';
  const wanted = typeof ref === 'string' ? ref.trim().replace(/^@/, '') : '';
  const hit = wanted ? all.find(c => c.token === wanted.toUpperCase() || c.name.toLowerCase() === wanted.toLowerCase()) : undefined;
  if (!hit) return { error: `Karakter "${wanted.slice(0, 40)}" tidak ada. Karakter yang ada: ${list}.` };
  return { token: hit.token, name: hit.name, ...(hit.card ? { card: hit.card } : {}), ...(hit.spec !== undefined ? { spec: hit.spec } : {}) };
}

/** A location by KEY or name (any case), from either side of the board. */
export function resolveLocation(board: Storyboard, ref: unknown): { key: string } | { error: string } {
  const all = new Map<string, string>();
  for (const l of board.bible?.locations ?? []) all.set(l.key, l.name);
  for (const [key, l] of Object.entries(board.locations ?? {})) if (!all.has(key)) all.set(key, l.name);
  const wanted = typeof ref === 'string' ? ref.trim().replace(/^#/, '') : '';
  for (const [key, name] of all) if (key === wanted.toUpperCase() || name.toLowerCase() === wanted.toLowerCase()) return { key };
  const list = all.size ? [...all].map(([k, n]) => `${k} (${n})`).join(', ') : 'belum ada';
  return { error: `Lokasi "${wanted.slice(0, 40)}" tidak ada. Lokasi yang ada: ${list}.` };
}

export type MediaPaths = { storyDir: string; framePath: (shotId: string) => string; castPath: (token: string) => string };

/**
 * A reference as an upload file of this story (`uploads/up_….ext`): an upload id/file name, or a
 * pointer to project media ("keyframe shot 2", "sheet LARAS"), which is copied into uploads so a
 * later redraw cannot change what the reference shows.
 */
export async function resolveReference(board: Storyboard, ref: unknown, paths: MediaPaths): Promise<{ rel: string } | { error: string }> {
  const text = typeof ref === 'string' ? ref.trim() : '';
  const usage = 'Referensi harus id unggahan (up_…), "keyframe shot N" atau "sheet NAMA".';
  if (!text) return { error: usage };
  if (/^(uploads\/)?up_/.test(text)) {
    const file = findUpload(paths.storyDir, text);
    return file ? { rel: `uploads/${file}` } : { error: `Referensi ${text.slice(0, 40)} tidak ditemukan di proyek ini.` };
  }
  const frame = /^(?:keyframe|frame|gambar)\s+(.+)$/i.exec(text);
  if (frame) {
    const shot = resolveShot(board, frame[1]!.trim());
    if ('error' in shot) return { error: `Referensi: ${shot.error}` };
    const copied = await copyToUploads(paths.storyDir, paths.framePath(shot.id));
    return copied ? { rel: `uploads/${copied.file}` } : { error: `Referensi tidak ada: keyframe shot ${shot.n} belum dibuat.` };
  }
  const sheet = /^(?:sheet|lembar(?:\s+karakter)?)\s+(.+)$/i.exec(text);
  if (sheet) {
    const who = resolveCharacter(board, sheet[1]!.trim());
    if ('error' in who) return { error: `Referensi: ${who.error}` };
    const copied = await copyToUploads(paths.storyDir, paths.castPath(who.token));
    return copied ? { rel: `uploads/${copied.file}` } : { error: `Referensi tidak ada: sheet ${who.name} belum dibuat.` };
  }
  return { error: usage };
}

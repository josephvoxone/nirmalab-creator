/**
 * Story bible on the web side (spec §4.2): the story design a project renders from — logline,
 * three-act-per-beat structure, characters with visual anchors, and a goal per scene.
 *
 * Pure functions only. The server owns the hard validation (`server/src/bible/story.ts`); this
 * mirror seeds a new bible from the board and explains what is still empty, so the tab can warn
 * while the user is drafting instead of refusing to save.
 */
import type { Board, CharacterSpec } from '../project/model.js';

export type ActId = 'hook' | 'setup' | 'turn' | 'payoff';
export type Audience = 'dewasa' | 'anak' | 'umum';

export type BibleCharacter = {
  token: string; name: string;
  /** Facts you can see (shape, proportion, one feature, one material) — never a feeling. */
  anchors: string[];
  want: string; need: string; arc: string; sheet?: string;
};
export type BibleScene = { id: string; title: string; goal: string; location?: string };
export type BibleStructure = { act: ActId; goal: string; beat?: string };

export type StoryBible = {
  logline: string; theme: string; tone: string; audience: Audience;
  structure: BibleStructure[];
  characters: BibleCharacter[];
  locations?: Array<{ key: string; name: string; look?: string }>;
  scenes: BibleScene[];
  rules?: { maxShotSec: number; narrationMaxWords: number };
};

export const ACTS: Array<{ id: ActId; label: string; hint: string }> = [
  { id: 'hook', label: 'Hook', hint: 'Detik pertama: kenapa orang berhenti menggulir' },
  { id: 'setup', label: 'Setup', hint: 'Siapa yang diikuti dan apa yang ia inginkan' },
  { id: 'turn', label: 'Turn', hint: 'Halangan atau kejutan yang membalik arah' },
  { id: 'payoff', label: 'Payoff', hint: 'Emosi yang dibayar di akhir' }
];

export const AUDIENCES: Array<{ value: Audience; label: string; hint: string }> = [
  { value: 'umum', label: 'Umum', hint: 'Semua umur, tanpa adegan berat' },
  { value: 'dewasa', label: 'Dewasa', hint: 'Tema dan ritme untuk 17+' },
  { value: 'anak', label: 'Anak', hint: 'Aman untuk anak, bahasa sederhana' }
];

const text = (value: unknown, max = 600) => (typeof value === 'string' ? value.slice(0, max) : '');
const nameOf = (token: string, spec: CharacterSpec | undefined) =>
  typeof spec === 'string' ? token : text(spec?.name, 80) || token;

/** Read whatever the board carries into a complete bible (missing parts empty, never invented). */
export function readBible(raw: unknown): StoryBible | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Partial<StoryBible>;
  const structure = Array.isArray(b.structure) ? b.structure : [];
  return {
    logline: text(b.logline, 400), theme: text(b.theme, 200), tone: text(b.tone, 200),
    audience: b.audience === 'anak' || b.audience === 'dewasa' ? b.audience : 'umum',
    structure: ACTS.map(act => {
      const found = structure.find(s => s?.act === act.id);
      return { act: act.id, goal: text(found?.goal), beat: text(found?.beat) };
    }),
    characters: (Array.isArray(b.characters) ? b.characters : [])
      .filter(c => c && typeof c === 'object')
      .map(c => ({
        token: text(c.token, 40), name: text(c.name, 80) || text(c.token, 40),
        anchors: (Array.isArray(c.anchors) ? c.anchors : []).filter((a): a is string => typeof a === 'string').map(a => a.slice(0, 160)),
        want: text(c.want), need: text(c.need), arc: text(c.arc)
      })),
    scenes: (Array.isArray(b.scenes) ? b.scenes : [])
      .filter(s => s && typeof s === 'object')
      .map(s => ({ id: text(s.id, 80), title: text(s.title, 80) || text(s.id, 80), goal: text(s.goal) })),
    rules: { maxShotSec: 6, narrationMaxWords: 12 }
  };
}

/** "Buat bible": start from what the board already knows — logline, cast and scenes. */
export function seedBible(board: Board): StoryBible {
  return {
    logline: text(board.logline, 400), theme: '', tone: '', audience: 'umum',
    structure: ACTS.map(act => ({ act: act.id, goal: '', beat: '' })),
    characters: Object.entries(board.characters ?? {}).map(([token, spec]) => ({
      token, name: nameOf(token, spec), anchors: [], want: '', need: '', arc: ''
    })),
    scenes: (board.scenes ?? []).map(s => ({ id: s.id, title: s.title, goal: '', ...(s.location ? { location: s.location } : {}) })),
    rules: { maxShotSec: 6, narrationMaxWords: 12 }
  };
}

/** Feelings, not facts: an anchor made only of these says nothing a model can draw. */
const GENERIC = new Set([
  'indah', 'cantik', 'tampan', 'megah', 'epik', 'epic', 'keren', 'bagus', 'hebat', 'luar', 'biasa', 'memukau',
  'menawan', 'molek', 'elok', 'anggun', 'gagah', 'sinematik', 'cinematic', 'dramatis', 'beautiful', 'pretty',
  'handsome', 'stunning', 'gorgeous', 'amazing', 'grand', 'cool', 'nice'
]);
const FILLER = new Set(['dan', 'yang', 'sangat', 'sekali', 'a', 'an', 'the', 'with']);

export function isGenericAnchor(anchor: string): boolean {
  const words = anchor.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !FILLER.has(w));
  return words.length > 0 && words.every(w => GENERIC.has(w));
}

/** What still has to be filled in, in plain Indonesian — a warning, never a save blocker. */
export function bibleWarnings(bible: StoryBible): string[] {
  const out: string[] = [];
  if (!bible.logline.trim()) out.push('Logline belum diisi — satu kalimat: siapa, ingin apa, halangannya apa.');
  if (!bible.theme.trim()) out.push('Tema belum diisi — mis. "kesetiaan yang tidak dihitung".');
  if (!bible.tone.trim()) out.push('Tone belum diisi — mis. "hangat, sedikit sedih".');
  const acts = new Set(bible.structure.map(s => s.act));
  if (!acts.has('hook') || !acts.has('payoff')) out.push('Struktur belum lengkap: butuh hook dan payoff.');
  for (const act of ACTS) {
    if (!bible.structure.find(s => s.act === act.id)?.goal.trim()) out.push(`Tujuan act ${act.label} belum diisi.`);
  }
  for (const c of bible.characters) {
    const who = c.name || c.token;
    if (!c.want.trim() || !c.need.trim()) out.push(`${who}: want dan need belum lengkap.`);
    const filled = c.anchors.filter(a => a.trim());
    if (!filled.length) out.push(`${who}: belum ada anchor visual (bentuk, proporsi, satu ciri, satu material).`);
    for (const a of filled) if (isGenericAnchor(a)) out.push(`${who}: anchor "${a.trim()}" hanya kata rasa — tulis fakta yang bisa dilihat.`);
  }
  for (const s of bible.scenes) if (!s.goal.trim()) out.push(`Tujuan scene "${s.title || s.id}" belum diisi.`);
  return out;
}

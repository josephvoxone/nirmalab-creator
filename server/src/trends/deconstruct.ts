/**
 * Deconstruction of a trend, and the clone brief it turns into (spec §4.5, §9.8).
 *
 * Two pure steps:
 *   deconstruct()  — title/description/duration (+ optional transcript) → hook type, beat
 *                    map with second marks, shot count and average cut, caption style, audio.
 *   cloneBrief()   — a trend card → the structure to copy, a look that fits it, and the same
 *                    number of shots with empty slots.
 *
 * Nothing here calls an LLM: the rules are keyword and arithmetic based on purpose, so the
 * page works with no model budget and every card explains itself. The clone copies the
 * STRUCTURE only — beats, pacing, hook kind, audio kind. Story and assets are new, which is
 * the line the spec draws (§4.5 "Struktur ditiru, cerita dan aset baru").
 */
import { DEFAULT_RULES, type SceneCard, type StoryBible } from '../bible/story.js';
import type { Storyboard } from '../stories/storyboard.js';
import {
  BEAT_LABELS,
  HOOK_LABELS,
  type AudioType,
  type BeatMark,
  type BeatName,
  type CaptionStyle,
  type CloneBrief,
  type HookType,
  type Niche,
  type TrendItem
} from './types.js';

/** Average cut length of a short-form video; the shot estimate divides by it. */
export const SHOT_SEC = 3.5;
/** A clone we can actually fill: fewer is not a story, more is not a short. */
export const MIN_CLONE_SHOTS = 4;
export const MAX_CLONE_SHOTS = 14;
/** Fallback when a source gave no duration (trending boards are phrases, not posts). */
export const DEFAULT_TREND_SEC = 15;

/** Fraction of the runtime where each act starts; the hook always starts at 0. */
export const BEAT_FRACTIONS: Readonly<Record<BeatName, number>> = { hook: 0, setup: 0.2, turn: 0.55, payoff: 0.8 };

export type Deconstruction = {
  hook: HookType;
  hookLabel: string;
  beats: BeatMark[];
  shotCount: number;
  avgShotSec: number;
  captionStyle: CaptionStyle;
  audioType: AudioType;
  /** The call to action the caption carries, verbatim, when it has one. */
  cta?: string;
};

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Runtime used for pacing: a missing/absurd duration falls back to the 15 s default. */
export function durationOf(durationSec: number | undefined): number {
  const d = finite(durationSec);
  return d >= 1 ? Math.min(d, 3_600) : DEFAULT_TREND_SEC;
}

/** duration / 3.5, rounded, clamped to 4–14 shots. */
export function shotCountFor(durationSec: number | undefined): number {
  const raw = Math.round(durationOf(durationSec) / SHOT_SEC);
  return Math.min(Math.max(raw, MIN_CLONE_SHOTS), MAX_CLONE_SHOTS);
}

/** Average cut: runtime divided by the shot count we would actually shoot. */
export function avgShotFor(durationSec: number | undefined): number {
  return round1(durationOf(durationSec) / shotCountFor(durationSec));
}

/** hook 0 s → setup 20% → turn 55% → payoff 80% of the runtime. */
export function beatMarks(durationSec: number | undefined): BeatMark[] {
  const d = durationOf(durationSec);
  return (Object.keys(BEAT_FRACTIONS) as BeatName[]).map(beat => ({
    beat,
    atSec: round1(BEAT_FRACTIONS[beat] * d),
    label: BEAT_LABELS[beat]
  }));
}

const QUESTION_START = /^(kenapa|mengapa|gimana|bagaimana|apa|apakah|siapa|kapan|dimana|di mana|berapa|why|how|what|who|when|which|where)\b/i;
const POV = /\bpov\b|point of view|sudut pandang/i;
const BEFORE_AFTER = /\b(sebelum|sesudah|sebelum-sesudah|before|after|transformasi|makeover|glow ?up|dulu vs sekarang)\b/i;
const TEKS_HOOK = /\b(ternyata|jangan|stop|ini yang|rahasia|akhirnya|tidak ada yang|nobody tells you|here is why)\b/i;
const UPPERCASE_WORD = /\b[A-Z][A-Z0-9]{2,}\b/g;
const CTA_WORDS = /\b(follow|ikuti|komen|comment|simpan|save|share|bagikan|subscribe|link di bio|cek bio|dm)\b/i;

/**
 * Hook kind, decided by an explicit priority so the badge is stable:
 * POV → question → before/after → text hook → visual surprise (the default).
 * A question mark anywhere wins over the text-hook markers, because a question is the
 * stronger read of the first frame.
 */
export function hookType(title: string, description = ''): HookType {
  const head = `${title} ${description}`.trim();
  if (POV.test(head)) return 'pov';
  if (head.includes('?') || QUESTION_START.test(title.trim())) return 'pertanyaan';
  if (BEFORE_AFTER.test(head)) return 'before-after';
  if (TEKS_HOOK.test(head) || countUppercase(title) >= 2) return 'teks-hook';
  return 'kejutan-visual';
}

function countUppercase(s: string): number {
  return (s.match(UPPERCASE_WORD) ?? []).length;
}

/**
 * Caption style: an explicit "tanpa caption" wins; big on-screen text is uppercase emphasis;
 * a fast transcript means moving captions; a slow one means tidy subtitles.
 */
export function captionStyle(title: string, description: string, transcript: string, durationSec: number): CaptionStyle {
  const head = `${title} ${description}`;
  if (/tanpa (caption|teks|subtitle)|no (caption|captions|subtitles|text)/i.test(head)) return 'tanpa-caption';
  if (countUppercase(title) >= 2 || /teks besar|big text|hook text/i.test(head)) return 'teks-besar';
  const words = wordsOf(transcript);
  if (words === 0) return 'tanpa-caption';
  const perSec = words / Math.max(durationOf(durationSec), 1);
  return perSec >= 2.5 ? 'caption-bergerak' : 'subtitle-rapi';
}

/**
 * Audio kind: the caption is the only evidence we have, so its words decide. A sound name
 * beats a voice-over marker, an explicit "tanpa audio" beats the transcript, and a spoken
 * transcript longer than a breath is a voice-over even when nobody wrote "VO".
 */
export function audioType(title: string, description: string, transcript: string): AudioType {
  const head = `${title} ${description}`;
  if (/sound (viral|tren|trending)|lagu viral|trending (sound|audio)|audio viral/i.test(head)) return 'sound-tren';
  if (/tanpa (audio|suara)|no audio|mute\b|silent/i.test(head)) return 'tanpa-audio';
  // "tanpa narasi, cuma musik" is the opposite of a voice-over, so the negation is read first.
  if (/tanpa narasi|no narrat|no voice ?over|tanpa vo\b/i.test(head)) return 'musik';
  if (/\bvo\b|voice ?over|narasi|narrat|dubbing|storytelling/i.test(head)) return 'vo';
  if (wordsOf(transcript) >= 8) return 'vo';
  return 'musik';
}

function wordsOf(text: string): number {
  return (clean(text).match(/[\p{L}\p{N}']+/gu) ?? []).length;
}

/** The first sentence of the caption that asks for something, verbatim. */
export function callToAction(description: string): string | undefined {
  const sentences = clean(description).split(/(?<=[.!?])\s+/).filter(Boolean);
  const hit = sentences.find(s => CTA_WORDS.test(s));
  return hit ? hit.slice(0, 120) : undefined;
}

/** Everything the drawer shows about one trend. Pure; same input, same output. */
export function deconstruct(input: {
  title: string;
  description?: string;
  durationSec?: number;
  transcript?: string;
}): Deconstruction {
  const title = clean(input.title);
  const description = clean(input.description);
  const transcript = clean(input.transcript);
  const durationSec = durationOf(input.durationSec);
  const hook = hookType(title, description);
  const cta = callToAction(description);
  return {
    hook,
    hookLabel: HOOK_LABELS[hook],
    beats: beatMarks(durationSec),
    shotCount: shotCountFor(durationSec),
    avgShotSec: avgShotFor(durationSec),
    captionStyle: captionStyle(title, description, transcript, durationSec),
    audioType: audioType(title, description, transcript),
    ...(cta ? { cta } : {})
  };
}

// ---------------------------------------------------------------------------
// clone brief
// ---------------------------------------------------------------------------

const GOALS: Readonly<Record<BeatName, (hook: string, atSec: number) => string>> = {
  hook: hook => `Tahan 3 detik pertama dengan hook ${hook} versi baru — bukan kalimat tren yang disalin.`,
  setup: (_hook, atSec) => `Bangun konteks di detik ${atSec}: siapa tokohnya, ia ingin apa, dan apa yang menghalangi.`,
  turn: (_hook, atSec) => `Balik arah di detik ${atSec}: penghalang memaksa tokoh memilih jalan yang lebih sulit.`,
  payoff: (_hook, atSec) => `Tutup di detik ${atSec}: perubahan yang terlihat, lalu satu ajakan singkat.`
};

const SCENE_TITLES: Readonly<Record<BeatName, string>> = {
  hook: 'Pembuka',
  setup: 'Dasar cerita',
  turn: 'Balik arah',
  payoff: 'Penutup'
};

/**
 * Look that fits the trend. Family/variant ids are the ones the bible compiler knows
 * (`bible/styles.ts`); the reason string is what the UI shows beside the pick.
 */
export function suggestLook(text: string, niche?: Niche): CloneBrief['look'] {
  const hay = text.toLowerCase();
  if (/\b(anak|kids|dongeng|kartun|balita|storybook)\b/.test(hay) || niche === 'anak') {
    return { family: 'painterly', variant: 'storybook', reason: 'Cerita anak: cat air lembut, bukan live-action' };
  }
  if (/\b(anime|manga|animasi 2d|cel)\b/.test(hay)) {
    return { family: 'cel-anime', variant: 'anime-2d', reason: 'Tren beranimasi cel: garis tangan dan cel shading' };
  }
  if (/\b(3d|pixar|clay|plastisin|stop ?motion)\b/.test(hay)) {
    return { family: 'clay', variant: 'pixar-3d', reason: 'Tren 3D/mainan: tekstur buatan tangan yang lucu' };
  }
  if (/\b(dokumenter|documentary|vlog|pov|footage|asli)\b/.test(hay)) {
    return { family: 'docu', variant: 'docu', reason: 'Tren observasional: cahaya alami, tanpa gaya menonjol' };
  }
  if (/\b(noir|misteri|gelap|detektif|thriller)\b/.test(hay)) {
    return { family: 'noir', variant: 'noir', reason: 'Tren misteri: kontras tinggi dan monokrom' };
  }
  // Spec §9.5: drama and faceless default to film-real.
  return { family: 'film-real', variant: 'cinematic-drama', reason: 'Default drama/faceless: live-action sinematik' };
}

/** Which beat a shot's midpoint falls into. */
function beatAt(marks: BeatMark[], midpoint: number): BeatName {
  let found: BeatName = 'hook';
  for (const mark of marks) if (mark.atSec <= midpoint) found = mark.beat;
  return found;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A trend card → the plan for the clone. Deterministic: the same card always yields the same
 * shot ids, marks and goals, so a second click cannot create a differently shaped project.
 */
export function cloneBrief(item: TrendItem, options: { title?: string } = {}): CloneBrief {
  const hook = item.hook;
  const hookLabel = HOOK_LABELS[hook];
  const durationSec = durationOf(item.durationSec);
  const durationEstimated = !(finite(item.durationSec) >= 1);
  const beats = item.beats.length ? item.beats : beatMarks(durationSec);
  const shotCount = Math.min(Math.max(item.shotCount || shotCountFor(durationSec), MIN_CLONE_SHOTS), MAX_CLONE_SHOTS);
  const step = durationSec / shotCount;

  const structure = beats.map(mark => ({
    act: mark.beat,
    goal: GOALS[mark.beat](hookLabel, mark.atSec),
    beat: `${SCENE_TITLES[mark.beat]} pada tren "${item.title.slice(0, 60)}" (detik ${mark.atSec}).`
  }));

  const shots = Array.from({ length: shotCount }, (_, i) => {
    const beat = beatAt(beats, (i + 0.5) * step);
    const goal = structure.find(s => s.act === beat)?.goal ?? structure[0]!.goal;
    return {
      id: `${pad2(i)}-${beat}`,
      beat,
      atSec: round1(i * step),
      goal: `Shot ${i + 1}/${shotCount} · ${BEAT_LABELS[beat]} — ${goal}`
    };
  });

  const scenes = beats.map(mark => ({
    id: mark.beat,
    title: `${SCENE_TITLES[mark.beat]} (${mark.atSec} dtk)`,
    goal: structure.find(s => s.act === mark.beat)!.goal,
    shots: shots.filter(s => s.beat === mark.beat).map(s => s.id)
  }));

  return {
    sourceId: `${item.source}:${item.id}`,
    source: item.source,
    title: (options.title?.trim() || `${item.title.trim()} (versi baru)`).slice(0, 90),
    hook,
    audioType: item.audioType,
    captionStyle: item.captionStyle,
    beats,
    structure,
    look: suggestLook(`${item.title}`, undefined),
    scenes,
    shots,
    durationEstimated
  };
}

const TONE: Readonly<Record<AudioType, string>> = {
  vo: 'hangat dan jelas',
  musik: 'tenang dan reflektif',
  'sound-tren': 'cepat dan energik',
  'tanpa-audio': 'hening dan visual'
};

const AUDIO_LINE = 'Audio: voice-over Bahasa Indonesia yang tenang, membaca narasi: "{line}". Ambience natural tipis di bawahnya.';
const AUDIO_SILENT = 'Audio: ambience lembut dan musik orkestra pelan. Tanpa suara, tanpa dialog.';
const NEGATIVE = 'Negative prompt: subtitles, captions, on-screen text, watermark, logos, camera equipment, film crew, warped hands.';

/**
 * The brief → a real storyboard that StoryService accepts as a `draft`.
 *
 * Spec §9.8: strict at render, loose at save. Every shot carries an intent with EMPTY slots
 * (subject/action/state), so `validateStoryboard` passes and the compiler refuses at render
 * until a human fills them — that is exactly the gate we want, and it is why the narration
 * here is a placeholder the editor replaces, not prose pretending to be the story.
 */
export function briefToStoryboard(brief: CloneBrief, options: { niche?: Niche } = {}): Storyboard {
  const goals = new Map(brief.structure.map(s => [s.act, s.goal]));
  const scenes: SceneCard[] = brief.scenes.map(scene => ({
    id: scene.id,
    title: scene.title.slice(0, 80),
    goal: (goals.get(scene.id as BeatName) ?? scene.goal).slice(0, 300)
  }));

  const bible: StoryBible = {
    logline: `Struktur diambil dari tren ${brief.source}; tokoh dan penghalangnya belum ditentukan.`,
    theme: 'Tiru strukturnya, ganti ceritanya.',
    tone: TONE[brief.audioType],
    audience: options.niche === 'anak' ? 'anak' : 'umum',
    structure: brief.structure,
    characters: [],
    locations: [],
    scenes,
    rules: { ...DEFAULT_RULES }
  };

  return {
    title: brief.title,
    mode: 'cepat',
    aspect: '9:16',
    look: { family: brief.look.family, variant: brief.look.variant },
    logline: bible.logline,
    audio: AUDIO_LINE,
    audioSilent: AUDIO_SILENT,
    negative: NEGATIVE,
    crossfade: 0.3,
    narrator: 'a warm, gentle Indonesian female storyteller (voice-over only, not on screen)',
    characters: {},
    locations: {},
    scenes: brief.scenes.map(scene => ({
      id: scene.id,
      title: scene.title.slice(0, 80),
      summary: scene.goal.slice(0, 300),
      shots: [...scene.shots]
    })),
    shots: brief.shots.map(shot => ({
      id: shot.id,
      // No prose: `prompt` stays empty because a bible board compiles from intent, and the
      // intent below is deliberately empty (the compiler refuses it at render).
      prompt: '',
      intent: { subject: '', action: '', startState: '', endState: '' },
      narration: `Isi narasi ${BEAT_LABELS[shot.beat]} untuk shot ini.`
    })),
    bible
  };
}

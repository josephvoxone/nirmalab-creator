/**
 * Premise → storyboard with an LLM, then validated against the same Veo rules the
 * renderer enforces. Invalid drafts are sent back with the exact errors (max 3 tries).
 *
 * The writer returns INTENT, not prompt prose (spec §4.2/§4.3/§9.6): a story bible plus
 * per-shot `intent {subject, action, startState, endState, emotion}`. A deterministic
 * compiler turns that into the English prompt. Legacy replies that still carry a finished
 * English prompt and no intent are accepted: their intent is derived from the sentence and
 * flagged `intentDerived` so the compiler can warn instead of failing the draft.
 */
import { CATALOG, composeStyle, resolveLook, shotCountFor, type Look, type Option } from './looks.js';
import { LOCATION_KEY, MAX_LOCATIONS, MAX_NARRATION_WORDS, MAX_SCENES, SCENE_ID, normalizeScenes, validateStoryboard, type CharacterSpec, type Location, type Scene } from './storyboard.js';
import { anchorIsGeneric, DEFAULT_RULES, validateBible, type Audience, type CharacterCard, type SceneCard, type StructureAct, type StructureBeat, type StoryBible } from '../bible/story.js';
import type { DraftStoryboard, IntentShot, ShotIntent } from '../bible/intent.js';

export type TextGenerator = (system: string, prompt: string) => Promise<string>;

export type DraftInput = {
  premise: string;
  shots?: number;
  /** Visual style line, e.g. storybook watercolor / Pixar-like 3D / live-action drama. */
  style?: string;
  /** Studio template id (sets look, mode, narrator, shot count). */
  template?: string;
  /** Explicit picks override the template. */
  look?: Partial<Record<keyof Look, unknown>>;
  mode?: 'konsisten' | 'cepat';
  aspect?: '9:16' | '16:9';
  narrator?: string;
};

export const DEFAULT_STYLE = 'Style: hand-painted storybook illustration come alive, warm and gentle, soft watercolor textures, cinematic lighting, gentle film grain.';
export const DEFAULTS = {
  aspect: '9:16' as const,
  narrator: 'a warm, gentle Indonesian female storyteller (voice-over only, not on screen)',
  audio: 'Audio: voice-over by {narrator}, speaking Bahasa Indonesia slowly and clearly: "{line}" Quiet natural ambience underneath.',
  audioSilent: 'Audio: soft wind, distant birdsong, and a gentle emotional orchestral swell with strings. No voice, no dialogue.',
  negative: 'Negative prompt: subtitles, captions, on-screen text, watermark, logos, warped hands, camera equipment, camera crane, film crew, drone in frame, characters talking on screen, singing.',
  crossfade: 0.3
};

const SYSTEM = `You are a film director planning a short AI-video story for Google Veo.
You do NOT write the final prompt prose. You write INTENT: what is in frame, the ONE action of the beat, and what visibly changes between the first and the last frame. A deterministic compiler turns your intent plus the bibles into the English prompt, so intent must be concrete, visible and free of camera gear.
Return ONLY one JSON object, no commentary:
{"title": "...", "logline": "one Indonesian sentence: who wants what, and what stands in the way",
 "titleCard": {"lines": ["UP TO 2 SHORT", "UPPERCASE LINES"], "kicker": "short Indonesian tagline"},
 "bible": {
   "logline": "the same Indonesian logline",
   "theme": "short Indonesian phrase: what the story is really about",
   "tone": "short Indonesian phrase for the emotional register",
   "audience": "anak" | "umum" | "dewasa",
   "structure": [{"act": "hook" | "setup" | "turn" | "payoff", "goal": "Indonesian: what this act must achieve", "beat": "Indonesian: the event that does it"}],
   "characters": [{"token": "LARAS", "name": "Laras", "anchors": ["seven years old", "faded yellow cotton dress", "red plastic hair clip"], "want": "Indonesian sentence", "need": "Indonesian sentence", "arc": "Indonesian sentence: how the want turns into the need"}],
   "locations": [{"key": "PASAR_IKAN", "name": "Pasar Ikan", "lookdev": "English visual descriptor"}],
   "scenes": [{"id": "kebab-id", "title": "short Indonesian chapter title", "goal": "Indonesian: what the scene must achieve", "location": "PASAR_IKAN"}]
 },
 "characters": {"TOKEN": "full visual descriptor in English (age, look, clothing, one signature prop)"},
 "locations": {"PLACE_TOKEN": "visual descriptor of the place in English (setting, era, light, textures)"},
 "scenes": [{"id": "kebab-id", "title": "short Indonesian chapter title", "summary": "Indonesian: what happens", "location": "PLACE_TOKEN", "shots": ["shot ids in play order"]}],
 "shots": [{"id": "kebab-id", "silent": true|omitted, "framing": "Wide shot", "move": "the camera stays still",
   "intent": {"subject": "LARAS", "action": "lifts the lid of the basket", "startState": "Laras kneels, the basket shut and bolted", "endState": "the lid open, morning light falling inside", "emotion": "waspada lalu lega"},
   "narration": "..."}]}
Rules (they are checked by code; violations are sent back to you):
- "title", "titleCard.lines" and "kicker" are in Bahasa Indonesia (no English words), short and evocative.
- Each shot "id" is a short descriptive Indonesian kebab-case word for the beat (e.g. "pembuka", "badai", "pelukan"), never "shot-1".
- Shot 1 is a silent establishing intro ("silent": true, no narration) with empty open sky in the upper third for the title.
- Every other shot has "narration": ONE Indonesian sentence (or two very short ones), max ${MAX_NARRATION_WORDS} words, warm storyteller voice.
- Write "intent" for every shot. "subject" is a character TOKEN or one concrete noun phrase in the frame; "action" is ONE English verb chain, never two beats joined by "and then"; "startState" and "endState" are visible facts (posture, position, opening, object, light), never feelings, and they must differ.
- "emotion" is one or two Indonesian mood words for the beat (e.g. "tenang", "takut lalu berani").
- Shot "framing" must be picked from: ${CATALOG.framings.map(f => f.prompt).join('; ')}.
- Shot "move" must be exactly ONE camera move from: ${CATALOG.moves.map(m => m.prompt).join('; ')}. Vary the moves across shots; use "the camera stays still" for emotional beats.
- Never name camera gear (jib, crane, rig, dolly track, slider, gimbal, drone) — describe only the movement.
- Character TOKENs are the character's short Indonesian name in UPPERCASE (e.g. "LARAS", "KAPAS"), never generic words like "GIRL".
- Refer to characters ONLY by their UPPERCASE TOKEN inside intent and narration tokens; the token is replaced by its descriptor, keeping them consistent.
- Real emotional arc: setup, loss or conflict, struggle, turning point, reunion or resolution, quiet ending.
- "logline" is ONE Bahasa Indonesia sentence.
- "bible.logline", "bible.theme" and "bible.tone" are required and in Bahasa Indonesia; "bible.audience" is "anak", "umum" or "dewasa".
- "bible.structure" tells the whole film in order and MUST contain a "hook" act and a "payoff" act.
- "bible.characters" anchors are 2-4 concrete visible facts each (age, clothing, prop, material) — never bare adjectives like beautiful, indah, epic. Every character needs "want", "need" and "arc"; a character without a concrete anchor or a want/need is dropped.
- "bible.locations": 1-4 places; key is an UPPERCASE Indonesian token (e.g. "PASAR_IKAN", "RUMAH_NENEK"); value is an English visual descriptor. Do not repeat the place descriptor inside shot intent.
- "scenes" are the chapters of the film: 2-4 scenes for 6+ shots (1-2 for fewer), following setup, conflict, turning point, resolution. Each has an Indonesian "title" (max 6 words) and "summary" (one sentence), one "location" token from "locations", and "shots": the ids of its shots. Every shot belongs to exactly one scene; scenes list the shots in the same order as "shots".
- "bible.scenes" needs one "goal" per chapter; use the same scene ids as "scenes".
- Never name camera gear or text in frame: no dialogue on screen, no subtitles.`;

export function parseJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'shot';

const tokenName = (token: string) => token.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 240): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Lenient: bad keys/empty looks are dropped, never sent back as errors. */
function draftLocations(raw: unknown): Record<string, Location> {
  if (!isObject(raw)) return {};
  const out: Record<string, Location> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_LOCATIONS || !LOCATION_KEY.test(key)) continue;
    const look = (typeof value === 'string' ? value : isObject(value) && typeof value.look === 'string' ? value.look : '').trim();
    const name = isObject(value) && typeof value.name === 'string' && value.name.trim() ? value.name.trim() : tokenName(key);
    if (look) out[key] = { name: name.slice(0, 80), look: look.slice(0, 400) };
  }
  return out;
}

/** Intent-first replies may only fill `bible.locations`; seed the board from it when the map is missing. */
function locationsFromBible(raw: unknown): Record<string, Location> {
  const out: Record<string, Location> = {};
  for (const item of Array.isArray(raw) ? raw : []) {
    if (Object.keys(out).length >= MAX_LOCATIONS || !isObject(item)) continue;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!LOCATION_KEY.test(key) || out[key]) continue;
    const look = text(item.look, 400) || text(item.lookdev, 400) || text(item.plate, 400);
    if (!look) continue;
    out[key] = { name: text(item.name, 80) || tokenName(key), look };
  }
  return out;
}

/** Lenient: the writer's shot ids are mapped through the same rewriting the shots get; anything unusable is dropped. */
function draftScenes(raw: unknown, ids: Map<string, string>, locations: Record<string, Location>): Scene[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const scenes: Scene[] = [];
  for (const item of raw) {
    if (scenes.length >= MAX_SCENES) break;
    if (!isObject(item)) continue;
    const n = scenes.length + 1;
    const rawId = typeof item.id === 'string' ? item.id.trim() : '';
    let id = rawId ? slug(rawId) : `scene-${n}`;
    if (!SCENE_ID.test(id)) id = `scene-${n}`;
    for (let k = 2; seen.has(id); k++) id = `${id.replace(/-\d+$/, '')}-${k}`;
    seen.add(id);
    const title = (typeof item.title === 'string' ? item.title.trim() : '').slice(0, 80).trim() || `Scene ${n}`;
    const summary = typeof item.summary === 'string' ? item.summary.trim().slice(0, 300) : '';
    const location = typeof item.location === 'string' && Object.prototype.hasOwnProperty.call(locations, item.location) ? item.location : undefined;
    const shots = (Array.isArray(item.shots) ? item.shots : []).map(v => ids.get(String(v)) ?? ids.get(slug(String(v)))).filter((v): v is string => !!v);
    scenes.push({ id, title, ...(summary ? { summary } : {}), ...(location ? { location } : {}), shots });
  }
  return scenes;
}

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

/** Present-tense English verbs used only to split a legacy prose sentence into subject + action. */
const VERBS = new Set([
  'hugs', 'holds', 'carries', 'waits', 'runs', 'walks', 'sits', 'stands', 'opens', 'closes', 'looks', 'turns',
  'lifts', 'reaches', 'finds', 'follows', 'watches', 'cries', 'laughs', 'sleeps', 'wakes', 'climbs', 'jumps',
  'drops', 'picks', 'places', 'plants', 'enters', 'leaves', 'searches', 'calls', 'feeds', 'saves', 'hides',
  'returns', 'smiles', 'waves', 'kneels', 'paints', 'reads', 'writes', 'draws', 'cooks', 'sweeps', 'rows',
  'sails', 'rides', 'drives', 'dances', 'sings', 'whispers', 'speaks', 'listens', 'breathes', 'takes',
  'gives', 'brings', 'puts', 'pulls', 'pushes', 'throws', 'catches', 'digs', 'builds', 'breaks', 'fixes',
  'mends', 'ties', 'unties', 'cuts', 'folds', 'pours', 'drinks', 'eats', 'bites', 'tastes', 'smells',
  'hears', 'sees', 'stares', 'touches', 'kisses', 'buries', 'hangs', 'falls', 'gets',
  'hugged', 'held', 'carried', 'waited', 'ran', 'walked', 'sat', 'stood', 'opened', 'closed', 'looked',
  'turned', 'lifted', 'reached', 'found', 'followed', 'watched', 'cried', 'jumped', 'dropped', 'entered',
  'left', 'smiled', 'waved', 'knelt', 'returned'
]);

const CAMERA_SENTENCE = /\bcamera\b/i;
const FRAMING_START = /^(extreme wide|wide|full|medium|close-up|medium close-up|medium shot|extreme close-up|over-the-shoulder|low-angle|high-angle|top-down|dutch|canted|slow|static)\b/i;
const NOUN_STOP = new Set(['at', 'in', 'on', 'with', 'near', 'by', 'of', 'from', 'under', 'above', 'behind', 'beside', 'toward', 'towards', 'against', 'and', 'while', 'as']);
const plain = (w: string) => w.toLowerCase().replace(/[^a-z'-]/g, '');

/** The prose sentence that actually describes the beat (camera/framing clauses dropped). */
function beatSentence(prose: string): string {
  const sentences = prose.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter(s => !CAMERA_SENTENCE.test(s) && !FRAMING_START.test(s));
  const picked = kept[0] ?? sentences[sentences.length - 1] ?? '';
  // "Wide shot, CAT runs home." → "CAT runs home." (only when what follows is not "of a place").
  const rest = picked.replace(/^[^,]{0,40}?\b(shot|close-up|view|angle)\b\s*,?\s*/i, '').trim();
  return rest && !NOUN_STOP.has(plain(rest.split(/\s+/)[0] ?? '')) ? rest : picked.trim();
}

/** Best-effort intent from one finished prose sentence: first noun phrase + first verb clause. */
export function deriveIntent(prose: string): ShotIntent | null {
  const body = beatSentence(prose).replace(/[.\s]+$/, '');
  if (!body) return null;
  const words = body.split(/\s+/).filter(Boolean);
  let at = words.findIndex(w => VERBS.has(plain(w)));
  if (at < 0) at = words.findIndex(w => ['is', 'are', 'was', 'were'].includes(plain(w)));
  let subject = '';
  let action = '';
  if (at > 0) {
    subject = words.slice(0, at).join(' ').replace(/[,;:]+$/, '').trim();
    action = words.slice(at).join(' ').replace(/[.\s]+$/, '').trim();
  } else if (at === 0) {
    action = words.join(' ').replace(/[.\s]+$/, '').trim();
  } else {
    // No verb at all (an establishing frame): keep the leading noun phrase, invent no action.
    const stop = words.findIndex((w, i) => i > 0 && NOUN_STOP.has(plain(w)));
    subject = words.slice(0, stop > 0 ? stop : Math.min(words.length, 4)).join(' ').replace(/[,;:]+$/, '').trim();
    action = 'remains still';
  }
  if (!subject) subject = 'the subject';
  if (!action) action = 'remains still';
  return {
    subject,
    action,
    startState: `${subject} in the opening frame, before the action begins`,
    endState: `${subject} in the closing frame, the action complete`,
    emotion: 'neutral'
  };
}

/** Authored intent wins; a legacy prose sentence gets a derived intent flagged for the compiler. */
function draftIntent(raw: unknown, prose: string): { intent?: ShotIntent; derived: boolean } {
  if (isObject(raw)) {
    const subject = text(raw.subject, 120);
    const action = text(raw.action, 200) || text(raw.beat, 200);
    if (subject && action) {
      const startState = text(raw.startState, 200);
      const endState = text(raw.endState, 200);
      const emotion = text(raw.emotion, 80);
      return {
        intent: {
          subject,
          action,
          startState: startState || `${subject} in the opening frame, before the action begins`,
          endState: endState || `${subject} in the closing frame, the action complete`,
          ...(emotion ? { emotion } : {})
        },
        // Partly inferred (a missing state or mood) still gets flagged, so the compiler warns.
        derived: !startState || !endState || !emotion
      };
    }
  }
  const derived = deriveIntent(prose);
  return derived ? { intent: derived, derived: true } : { derived: false };
}

const matchOption = (options: readonly Option[], value: unknown): string | undefined => {
  const needle = text(value, 120).toLowerCase();
  if (!needle) return undefined;
  const hit = options.find(o => o.id === needle || o.prompt.toLowerCase() === needle || o.label.toLowerCase() === needle);
  return hit?.prompt;
};

/** Deterministic camera per position: establish, hold, close. Catalog text only, so Veo-safe. */
function defaultCamera(i: number, count: number): { framing: string; move: string } {
  const framing = i === 0 ? 'Extreme wide shot' : i === count - 1 ? 'Wide shot' : i % 2 ? 'Medium shot' : 'Medium close-up';
  const move = i === 0 ? 'the camera pushes in slowly' : i === count - 1 ? 'the camera pulls back slowly' : 'the camera stays still';
  return { framing, move };
}

/** Legacy boards render from their prose `prompt`; intent-first replies get one built from the intent. */
function synthPrompt(intent: ShotIntent, framing: string, move: string): string {
  const subject = intent.subject.trim().replace(/[.\s]+$/, '');
  const action = intent.action.trim().replace(/[.\s]+$/, '');
  const body = action.toLowerCase().startsWith(subject.toLowerCase()) ? action : `${subject} ${action}`;
  return `${framing}, ${move}. ${body}.`.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// story bible (spec §4.2) — lenient: unusable sections are dropped, never fatal
// ---------------------------------------------------------------------------

const ACTS: StructureAct[] = ['hook', 'setup', 'turn', 'payoff'];
const AUDIENCES: Audience[] = ['dewasa', 'anak', 'umum'];

/** An anchor is kept only when it names something visible; the bible validator applies the same rule. */
function draftAnchors(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map(v => text(v, 120))
    .filter(a => a.length >= 3 && !anchorIsGeneric(a))
    .slice(0, 6);
}

function draftBibleCharacters(raw: unknown): CharacterCard[] {
  const out: CharacterCard[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= 20 || !isObject(item)) continue;
    const token = text(item.token, 24).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,20}$/.test(token) || seen.has(token)) continue;
    const anchors = draftAnchors(item.anchors);
    const want = text(item.want, 200);
    const need = text(item.need, 200);
    // A card without a visible anchor or a want/need would fail the bible validator: drop it.
    if (!anchors.length || !want || !need) continue;
    seen.add(token);
    const sheet = text(item.sheet, 400);
    out.push({
      token,
      name: text(item.name, 60) || tokenName(token),
      anchors,
      want,
      need,
      arc: text(item.arc, 200) || `${want} → ${need}`,
      ...(sheet ? { sheet } : {})
    });
  }
  return out;
}

function draftStructure(raw: unknown): StructureBeat[] {
  const out: StructureBeat[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= 8 || !isObject(item)) continue;
    const act = text(item.act, 20).toLowerCase() as StructureAct;
    const goal = text(item.goal, 160);
    const beat = text(item.beat, 160);
    if (!ACTS.includes(act) || !goal || !beat) continue;
    out.push({ act, goal, beat });
  }
  return out;
}

type BibleSpine = Pick<StoryBible, 'logline' | 'theme' | 'tone' | 'audience' | 'structure' | 'characters'>;

/**
 * The bible's spine: the fields a board cannot derive for itself (logline, theme, tone) plus
 * the model's structure and character cards. Whether the result is acceptable is decided by
 * `validateBible` — one rule, one place. A bible that fails it is dropped, never fatal: a
 * board without `bible` is still valid and renders on the legacy style path.
 */
function draftBibleSpine(raw: unknown, fallbackLogline: string): BibleSpine | undefined {
  if (!isObject(raw)) return undefined;
  const logline = text(raw.logline, 300) || fallbackLogline;
  const theme = text(raw.theme, 160);
  const tone = text(raw.tone, 160);
  if (!logline || !theme || !tone) return undefined;
  const audience = AUDIENCES.includes(raw.audience as Audience) ? raw.audience as Audience : 'umum';
  return { logline, theme, tone, audience, structure: draftStructure(raw.structure), characters: draftBibleCharacters(raw.characters) };
}

/** Voice-over chapter goals keyed by the scene id the board ended up with. */
function bibleSceneGoals(raw: unknown): Map<string, string> {
  const goals = new Map<string, string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item)) continue;
    const rawId = text(item.id, 60);
    const goal = text(item.goal, 160);
    const id = rawId ? slug(rawId) : '';
    if (id && goal && !goals.has(id)) goals.set(id, goal);
  }
  return goals;
}

/** Bible scenes/locations mirror the board, so the two can never point at different shots. */
function assembleBible(spine: BibleSpine, board: DraftStoryboard, goals: Map<string, string>): StoryBible {
  return {
    ...spine,
    // Board locations carry the English look; the bible uses the same string as its lookdev note.
    locations: Object.entries(board.locations ?? {}).map(([key, loc]) => ({ key, name: loc.name, ...(loc.look ? { lookdev: loc.look } : {}) })),
    scenes: (board.scenes ?? []).map((sc): SceneCard => ({
      id: sc.id,
      title: sc.title,
      goal: goals.get(sc.id) || sc.summary || `Beat: ${sc.title}`,
      ...(sc.location ? { location: sc.location } : {})
    })),
    rules: { ...DEFAULT_RULES }
  };
}

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

function normalise(raw: unknown, style: string): DraftStoryboard {
  const r = (raw ?? {}) as Record<string, unknown>;
  const shotsIn = (Array.isArray(r.shots) ? r.shots : []) as Array<Record<string, unknown>>;
  const titleCard = r.titleCard as { lines?: unknown; kicker?: unknown } | undefined;
  const logline = typeof r.logline === 'string' ? r.logline.trim().slice(0, 300) : '';
  const spine = draftBibleSpine(r.bible, logline);
  const goals = bibleSceneGoals(isObject(r.bible) ? r.bible.scenes : undefined);
  const ids = new Map<string, string>();
  const shots = shotsIn.map((s, i): IntentShot => {
    const rawId = String(s.id ?? `shot-${i}`);
    const id = `${String(i).padStart(2, '0')}-${slug(rawId).replace(/^\d+-/, '')}`;
    for (const key of [rawId, slug(rawId), id]) if (!ids.has(key)) ids.set(key, id);
    const prose = text(s.prompt, 1200);
    const { intent, derived } = draftIntent(s.intent, prose || text(s.narration, 400));
    const cam = defaultCamera(i, Math.max(shotsIn.length, 1));
    const framing = matchOption(CATALOG.framings, s.framing) ?? cam.framing;
    const move = matchOption(CATALOG.moves, s.move) ?? cam.move;
    // Legacy replies keep their prose; intent-first replies get a prompt built from the intent.
    const prompt = prose || (intent ? synthPrompt(intent, framing, move) : '');
    return {
      id,
      prompt,
      ...(s.silent === true ? { silent: true } : { narration: text(s.narration, 400) }),
      ...(intent ? { intent } : {}),
      ...(intent && derived ? { intentDerived: true } : {}),
      ...(intent && !derived ? { framing, move } : {})
    };
  });
  const mapped = draftLocations(r.locations);
  const locations = Object.keys(mapped).length ? mapped : locationsFromBible(isObject(r.bible) ? r.bible.locations : undefined);
  const scenes = draftScenes(r.scenes, ids, locations);
  const characters: Record<string, CharacterSpec> = Object.fromEntries(
    Object.entries((r.characters ?? {}) as Record<string, unknown>)
      .filter(([k, v]) => /^[A-Z][A-Z0-9_]{1,20}$/.test(k) && typeof v === 'string')
      .map(([k, v]) => [k, String(v)])
  );
  // Intent-first replies may only fill bible.characters; mirror them into the cast map so
  // character sheets and TOKEN expansion still work.
  if (!Object.keys(characters).length && spine?.characters.length) {
    for (const c of spine.characters) characters[c.token] = `${c.name}, ${c.anchors.join(', ')}`;
  }
  const board = normalizeScenes({
    title: String(r.title ?? '').trim(),
    ...DEFAULTS,
    style,
    characters,
    ...(Array.isArray(titleCard?.lines)
      ? { titleCard: { lines: titleCard!.lines.map(String).slice(0, 2), ...(titleCard!.kicker ? { kicker: String(titleCard!.kicker) } : {}) } }
      : {}),
    ...(logline ? { logline } : {}),
    ...(Object.keys(locations).length ? { locations } : {}),
    ...(scenes.length ? { scenes } : {}),
    shots
  }) as DraftStoryboard;
  if (!spine) return board;
  const bible = assembleBible(spine, board, goals);
  // Never store a bible its own validator would reject: a board without one still drafts and renders.
  return validateBible(bible).length ? board : { ...board, bible };
}

const SMALL = new Set(['di', 'ke', 'dan', 'yang', 'dari', 'untuk', 'pada', 'dengan', 'si', 'sang']);
const titleCase = (text: string) => text.toLowerCase().split(/(\s+)/)
  .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');

/** Narration is spoken Indonesian: character TOKENs become their names; an ALL-CAPS title becomes title case. */
function proseFix(board: DraftStoryboard): DraftStoryboard {
  const names = Object.keys(board.characters ?? {}).map(token => {
    const spec = board.characters![token];
    return [token, typeof spec === 'object' && spec?.name ? spec.name : titleCase(token.replace(/_/g, ' '))] as const;
  });
  const speak = (text: string) => names.reduce((t, [token, name]) => t.replace(new RegExp(`\\b${token}\\b`, 'g'), name), text);
  const title = /[a-z]/.test(board.title) ? board.title : titleCase(board.title);
  return {
    ...board,
    title,
    ...(board.logline ? { logline: speak(board.logline) } : {}),
    ...(board.bible ? { bible: { ...board.bible, logline: speak(board.bible.logline) } } : {}),
    ...(board.scenes ? { scenes: board.scenes.map(sc => ({ ...sc, title: speak(sc.title).slice(0, 80), ...(sc.summary ? { summary: speak(sc.summary).slice(0, 300) } : {}) })) } : {}),
    shots: board.shots.map(s => (s.narration ? { ...s, narration: speak(s.narration) } : s))
  };
}

export async function draftStoryboard(input: DraftInput, generate: TextGenerator): Promise<DraftStoryboard> {
  const template = CATALOG.templates.find(t => t.id === input.template);
  const useLook = !!template || !!input.look;
  const look = useLook ? resolveLook({ template: input.template, look: input.look }) : undefined;
  const count = Math.min(Math.max(Math.round(input.shots ?? (look ? shotCountFor(look) : 8)), 3), 12);
  const style = input.style?.trim()
    ? (input.style.trim().startsWith('Style:') ? input.style.trim() : `Style: ${input.style.trim()}`)
    : look ? composeStyle(look) : DEFAULT_STYLE;
  const mode = input.mode ?? template?.mode;
  const aspect = input.aspect ?? template?.aspect ?? DEFAULTS.aspect;
  const narrator = input.narrator?.trim() || (template ? `${template.narrator} (voice-over only, not on screen)` : undefined);
  const extra = {
    aspect,
    ...(mode ? { mode } : {}),
    ...(template ? { template: template.id } : {}),
    ...(look ? { look } : {}),
    ...(narrator ? { narrator } : {})
  };
  const base = [
    `Premise (Indonesian): ${input.premise.trim()}`,
    `Write exactly ${count} shots (6 seconds each), ${aspect === '16:9' ? 'horizontal 16:9' : 'vertical 9:16'} framing.`,
    'Write intent per shot (subject, action, startState, endState, emotion) plus the story bible — no finished prompt prose.',
    template ? `Format: ${template.name} — ${template.tagline}.` : '',
    mode === 'cepat' ? 'Recurring characters are optional (faceless / montage is fine).' : 'Keep a small recurring cast (1-3 characters) so they can stay consistent.',
    `Visual style for every shot: ${style}`
  ].filter(Boolean).join('\n');
  let prompt = base;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reply = '';
    try {
      reply = await generate(SYSTEM, prompt);
      const board = proseFix({ ...normalise(parseJsonBlock(reply), style), ...extra });
      problems = validateStoryboard(board);
      if (!problems.length) return board;
    } catch (error) {
      problems = [`reply was not valid JSON (${error instanceof Error ? error.message : String(error)})`];
    }
    prompt = `${base}\n\nYour previous storyboard broke these rules — return the corrected full JSON:\n- ${problems.join('\n- ')}${reply ? `\n\nPrevious reply:\n${reply.slice(0, 6000)}` : ''}`;
  }
  throw new Error(`Draft masih melanggar aturan setelah 3 percobaan: ${problems.join('; ')}`);
}

/**
 * StoryBible: the story half of the production bible (spec §4.2).
 *
 * The bible records intent — who wants what, what each scene changes, and visual anchors that
 * are facts rather than taste. `validateBible` returns Indonesian messages so the UI can show
 * them verbatim; the prompt compiler never guesses a missing slot.
 *
 * Pure: no IO, no dependency.
 */

export type Audience = 'dewasa' | 'anak' | 'umum';
export type StructureAct = 'hook' | 'setup' | 'turn' | 'payoff';

export type StructureBeat = {
  act: StructureAct;
  /** What this beat must achieve for the story. */
  goal: string;
  /** The beat itself, one line. */
  beat: string;
};

export type CharacterCard = {
  /** UPPERCASE token used in shot prompts (e.g. LARAS); expanded to the name. */
  token: string;
  name: string;
  /** Visible facts: shape, proportion, one signature detail, one material. Not adjectives. */
  anchors: string[];
  /** What the character pursues. */
  want: string;
  /** What the character actually needs. */
  need: string;
  arc: string;
  /** Character sheet asset id (konsisten mode). */
  sheet?: string;
};

export type BibleLocation = {
  key: string;
  name: string;
  /** Location plate asset id. */
  plate?: string;
  lookdev?: string;
};

export type SceneCard = {
  id: string;
  title: string;
  /** What changes in this scene — the shot list must serve it. */
  goal: string;
  location?: string;
  stateIn?: string;
  stateOut?: string;
};

export type StoryRules = { maxShotSec: number; narrationMaxWords: number };

export type StoryBible = {
  logline: string;
  theme: string;
  tone: string;
  audience: Audience;
  structure: StructureBeat[];
  characters: CharacterCard[];
  locations: BibleLocation[];
  scenes: SceneCard[];
  /** Absent = defaults (6 s shots, 12 narration words). */
  rules?: StoryRules;
};

export const DEFAULT_RULES: StoryRules = { maxShotSec: 6, narrationMaxWords: 12 };
export const MAX_CHARACTERS = 20;
export const MAX_BIBLE_SCENES = 20;

const AUDIENCES: Audience[] = ['dewasa', 'anak', 'umum'];
const ACTS: StructureAct[] = ['hook', 'setup', 'turn', 'payoff'];
const TOKEN = /^[A-Z][A-Z0-9_]{1,30}$/;
const LOCATION_KEY_RE = /^[A-Z][A-Z0-9_]{1,30}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Words that carry no visual fact: "beautiful woman" is a mood, "two black braids" is a fact.
 * Kept as regexes (no /g flag) so they can be tested word by word.
 */
export const GENERIC_ANCHOR: RegExp[] = [
  /\b(beautiful|stunning|gorgeous|handsome|pretty|cute|lovely|majestic|epic|cinematic|breathtaking|amazing|awesome|dramatic|elegant|iconic|perfect|radiant|glowing)\b/i,
  /\b(indah|megah|epik|sinematik|dramatis|keren|memukau|cantik|tampan|manis|elok|agung|hebat)\b/i,
  /\b(vibe|vibes|aesthetic|mood|energy|nuansa|kesan|gaya|suasana)\b/i,
  /\b(woman|women|man|men|person|people|girl|boy|guy|lady|gentleman|character|figure|someone|somebody)\b/i,
  /\b(orang|wanita|pria|gadis|lelaki|perempuan|tokoh|sosok|manusia|wajah|raut)\b/i
];

/** Articles, prepositions and intensifiers: never a visual fact on their own. */
const FILLER = new Set([
  'a', 'an', 'the', 'with', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by',
  'very', 'really', 'quite', 'so', 'too', 'more', 'most', 'his', 'her', 'their', 'its', 'it',
  'is', 'are', 'was', 'sebuah', 'seorang', 'seekor', 'yang', 'dan', 'atau', 'dengan', 'di', 'ke',
  'dari', 'untuk', 'ini', 'itu', 'sangat', 'begitu', 'sungguh', 'tampak', 'terlihat', 'sekali',
  'look', 'looks', 'style', 'shot', 'scene', 'gambar', 'adegan'
]);

/** True when an anchor is only generic adjectives/nouns, i.e. no concrete noun survives. */
export function anchorIsGeneric(anchor: string): boolean {
  const words = (anchor ?? '').toLowerCase().match(/[a-zà-ÿ0-9]+/g) ?? [];
  return !words.some(w => !FILLER.has(w) && !GENERIC_ANCHOR.some(re => re.test(w)));
}

export function rulesOf(bible: Pick<StoryBible, 'rules'> | undefined): StoryRules {
  const rules = bible?.rules;
  if (!rules) return { ...DEFAULT_RULES };
  return { maxShotSec: rules.maxShotSec, narrationMaxWords: rules.narrationMaxWords };
}

export function characterByToken(bible: StoryBible, token: string): CharacterCard | undefined {
  return bible.characters.find(c => c.token === token);
}

export function locationByKey(bible: StoryBible, key: string): BibleLocation | undefined {
  return bible.locations.find(l => l.key === key);
}

export function sceneById(bible: StoryBible, id: string): SceneCard | undefined {
  return bible.scenes.find(s => s.id === id);
}

/** Indonesian, ready to show in the Bible tab: every message names the field it is about. */
export function validateBible(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['bible harus berupa objek'];
  const b = input as Partial<StoryBible>;
  const errors: string[] = [];
  if (!text(b.logline)) errors.push('logline wajib diisi (satu kalimat: siapa ingin apa, dan apa penghalangnya)');
  if (!text(b.theme)) errors.push('tema wajib diisi');
  if (!text(b.tone)) errors.push('tone wajib diisi');
  if (!AUDIENCES.includes(b.audience as Audience)) errors.push('audience harus dewasa, anak atau umum');

  const structure = Array.isArray(b.structure) ? b.structure : [];
  if (!structure.length) errors.push('structure wajib berisi hook dan payoff');
  else {
    for (const [i, beat] of structure.entries()) {
      if (!ACTS.includes(beat?.act)) errors.push(`structure[${i}]: act harus hook, setup, turn atau payoff`);
      if (!text(beat?.goal)) errors.push(`structure[${i}]: goal wajib diisi (apa yang beat ini capai)`);
      // `beat` is the LLM's sentence for this act; a human-written bible may leave it empty.
    }
    if (!structure.some(beat => beat?.act === 'hook')) errors.push('structure wajib punya act "hook"');
    if (!structure.some(beat => beat?.act === 'payoff')) errors.push('structure wajib punya act "payoff"');
  }

  const characters = Array.isArray(b.characters) ? b.characters : [];
  // Faceless / cepat stories legitimately have no cast: an empty list is valid.
  if (characters.length > MAX_CHARACTERS) errors.push(`terlalu banyak karakter (maks ${MAX_CHARACTERS})`);
  const tokens = new Set<string>();
  for (const [i, c] of characters.entries()) {
    const token = text(c?.token) ? c.token : `#${i + 1}`;
    if (!TOKEN.test(c?.token ?? '')) errors.push(`karakter ${token}: token harus HURUF BESAR, angka atau garis bawah (mis. LARAS)`);
    else if (tokens.has(c.token)) errors.push(`karakter ${token}: token ganda`);
    else tokens.add(c.token);
    if (!text(c?.name)) errors.push(`karakter ${token}: name wajib diisi`);
    if (!text(c?.want)) errors.push(`karakter ${token}: want wajib diisi (apa yang ia kejar)`);
    if (!text(c?.need)) errors.push(`karakter ${token}: need wajib diisi (apa yang sebenarnya ia butuhkan)`);
    const anchors = (Array.isArray(c?.anchors) ? c.anchors : []).filter(text);
    if (!anchors.length) errors.push(`karakter ${token}: anchors wajib diisi (minimal satu fakta visual)`);
    for (const anchor of anchors) {
      if (anchorIsGeneric(anchor)) errors.push(`karakter ${token}: anchor "${anchor.trim()}" terlalu umum — sebut bentuk, proporsi, satu ciri atau material`);
    }
  }

  const locations = Array.isArray(b.locations) ? b.locations : [];
  const keys = new Set<string>();
  for (const loc of locations) {
    const key = text(loc?.key) ? loc.key : '(tanpa key)';
    if (!LOCATION_KEY_RE.test(loc?.key ?? '')) errors.push(`lokasi ${key}: key harus HURUF BESAR, angka atau garis bawah (mis. PASAR_IKAN)`);
    else if (keys.has(loc.key)) errors.push(`lokasi ${key}: key ganda`);
    else keys.add(loc.key);
    if (!text(loc?.name)) errors.push(`lokasi ${key}: name wajib diisi`);
  }
  if (b.locations !== undefined && !Array.isArray(b.locations)) errors.push('locations harus berupa daftar');

  const scenes = Array.isArray(b.scenes) ? b.scenes : [];
  // A fresh bible (or a CloneBrief before shots exist) may have no scenes yet: warn later, not here.
  if (scenes.length > MAX_BIBLE_SCENES) errors.push(`terlalu banyak scene (maks ${MAX_BIBLE_SCENES})`);
  const sceneIds = new Set<string>();
  for (const scene of scenes) {
    const id = text(scene?.id) ? scene.id : '(tanpa id)';
    if (!SCENE_ID.test(scene?.id ?? '')) errors.push(`scene ${id}: id harus huruf kecil, angka atau tanda hubung (mis. pasar)`);
    else if (sceneIds.has(scene.id)) errors.push(`scene ${id}: id ganda`);
    else sceneIds.add(scene.id);
    if (!text(scene?.title)) errors.push(`scene ${id}: title wajib diisi`);
    if (!text(scene?.goal)) errors.push(`scene ${id}: goal wajib diisi (apa yang berubah di scene ini)`);
    if (scene?.location !== undefined && !keys.has(scene.location)) errors.push(`scene ${id}: location ${scene.location} tidak ada di locations`);
  }

  if (b.rules !== undefined) {
    const rules = b.rules as Partial<StoryRules>;
    const seconds = rules?.maxShotSec;
    if (typeof seconds !== 'number' || !(seconds >= 1 && seconds <= 30)) errors.push('rules.maxShotSec harus angka 1–30 detik');
    const words = rules?.narrationMaxWords;
    if (typeof words !== 'number' || !(words >= 1 && words <= 40)) errors.push('rules.narrationMaxWords harus angka 1–40 kata');
  }

  return errors;
}

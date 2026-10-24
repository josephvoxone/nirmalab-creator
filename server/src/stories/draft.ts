/**
 * Premise → storyboard with an LLM, then validated against the same Veo rules the
 * renderer enforces. Invalid drafts are sent back with the exact errors (max 3 tries).
 */
import { CATALOG, composeStyle, resolveLook, shotCountFor, type Look } from './looks.js';
import { LOCATION_KEY, MAX_LOCATIONS, MAX_NARRATION_WORDS, MAX_SCENES, SCENE_ID, normalizeScenes, validateStoryboard, type Location, type Scene, type Shot, type Storyboard } from './storyboard.js';

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

const SYSTEM = `You are a film director writing a short AI-video story for Google Veo.
Return ONLY one JSON object, no commentary:
{"title": "...", "logline": "one Indonesian sentence: who wants what, and what stands in the way",
 "titleCard": {"lines": ["UP TO 2 SHORT", "UPPERCASE LINES"], "kicker": "short Indonesian tagline"},
 "characters": {"TOKEN": "full visual descriptor in English (age, look, clothing, one signature prop)"},
 "locations": {"PLACE_TOKEN": "visual descriptor of the place in English (setting, era, light, textures)"},
 "scenes": [{"id": "kebab-id", "title": "short Indonesian chapter title", "summary": "Indonesian: what happens", "location": "PLACE_TOKEN", "shots": ["shot ids in play order"]}],
 "shots": [{"id": "kebab-id", "silent": true|omitted, "prompt": "...", "narration": "..."}]}
Rules (they are checked by code; violations are sent back to you):
- "title", "titleCard.lines" and "kicker" are in Bahasa Indonesia (no English words), short and evocative.
- Each shot "id" is a short descriptive Indonesian kebab-case word for the beat (e.g. "pembuka", "badai", "pelukan"), never "shot-1".
- Shot 1 is a silent establishing intro ("silent": true, no narration) with empty open sky in the upper third for the title.
- Every other shot has "narration": ONE Indonesian sentence (or two very short ones), max ${MAX_NARRATION_WORDS} words, warm storyteller voice.
- "prompt" is English. Start with framing + exactly ONE camera move (e.g. "Medium close-up, the camera pushes in slowly."), then subject, action, setting, light.
- Pick the framing from: ${CATALOG.framings.map(f => f.prompt).join('; ')}.
- Pick the ONE camera move from: ${CATALOG.moves.map(m => m.prompt).join('; ')}. Vary the moves across shots; use "the camera stays still" for emotional beats.
- Never name camera gear (jib, crane, rig, dolly track, slider, gimbal, drone) — describe only the movement.
- Character TOKENs are the character's short Indonesian name in UPPERCASE (e.g. "LARAS", "KAPAS"), never generic words like "GIRL".
- Refer to characters ONLY by their UPPERCASE TOKEN inside prompts; the token is replaced by its descriptor, keeping them consistent.
- Real emotional arc: setup, loss or conflict, struggle, turning point, reunion or resolution, quiet ending.
- "logline" is ONE Bahasa Indonesia sentence.
- "locations": 1-4 places; key is an UPPERCASE Indonesian token (e.g. "PASAR_IKAN", "RUMAH_NENEK"); value is an English visual descriptor. Do not repeat the place descriptor inside shot prompts.
- "scenes" are the chapters of the film: 2-4 scenes for 6+ shots (1-2 for fewer), following setup, conflict, turning point, resolution. Each has an Indonesian "title" (max 6 words) and "summary" (one sentence), one "location" token from "locations", and "shots": the ids of its shots. Every shot belongs to exactly one scene; scenes list the shots in the same order as "shots".
- No dialogue on screen, no text in frame.`;

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

function normalise(raw: unknown, style: string): Storyboard {
  const r = (raw ?? {}) as Record<string, unknown>;
  const shotsIn = (Array.isArray(r.shots) ? r.shots : []) as Array<Record<string, unknown>>;
  const titleCard = r.titleCard as { lines?: unknown; kicker?: unknown } | undefined;
  const ids = new Map<string, string>();
  const shots = shotsIn.map((s, i): Shot => {
    const rawId = String(s.id ?? `shot-${i}`);
    const id = `${String(i).padStart(2, '0')}-${slug(rawId).replace(/^\d+-/, '')}`;
    for (const key of [rawId, slug(rawId), id]) if (!ids.has(key)) ids.set(key, id);
    return { id, prompt: String(s.prompt ?? ''), ...(s.silent === true ? { silent: true } : { narration: String(s.narration ?? '').trim() }) };
  });
  const locations = draftLocations(r.locations);
  const scenes = draftScenes(r.scenes, ids, locations);
  const logline = typeof r.logline === 'string' ? r.logline.trim().slice(0, 300) : '';
  return normalizeScenes({
    title: String(r.title ?? '').trim(),
    ...DEFAULTS,
    style,
    characters: Object.fromEntries(
      Object.entries((r.characters ?? {}) as Record<string, unknown>)
        .filter(([k, v]) => /^[A-Z][A-Z0-9_]{1,20}$/.test(k) && typeof v === 'string')
        .map(([k, v]) => [k, String(v)])
    ),
    ...(Array.isArray(titleCard?.lines)
      ? { titleCard: { lines: titleCard!.lines.map(String).slice(0, 2), ...(titleCard!.kicker ? { kicker: String(titleCard!.kicker) } : {}) } }
      : {}),
    ...(logline ? { logline } : {}),
    ...(Object.keys(locations).length ? { locations } : {}),
    ...(scenes.length ? { scenes } : {}),
    shots
  });
}

const SMALL = new Set(['di', 'ke', 'dan', 'yang', 'dari', 'untuk', 'pada', 'dengan', 'si', 'sang']);
const titleCase = (text: string) => text.toLowerCase().split(/(\s+)/)
  .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');

/** Narration is spoken Indonesian: character TOKENs become their names; an ALL-CAPS title becomes title case. */
function proseFix(board: Storyboard): Storyboard {
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
    ...(board.scenes ? { scenes: board.scenes.map(sc => ({ ...sc, title: speak(sc.title).slice(0, 80), ...(sc.summary ? { summary: speak(sc.summary).slice(0, 300) } : {}) })) } : {}),
    shots: board.shots.map(s => (s.narration ? { ...s, narration: speak(s.narration) } : s))
  };
}

export async function draftStoryboard(input: DraftInput, generate: TextGenerator): Promise<Storyboard> {
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

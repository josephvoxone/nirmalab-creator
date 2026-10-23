/**
 * Premise → storyboard with an LLM, then validated against the same Veo rules the
 * renderer enforces. Invalid drafts are sent back with the exact errors (max 3 tries).
 */
import { MAX_NARRATION_WORDS, validateStoryboard, type Shot, type Storyboard } from './storyboard.js';

export type TextGenerator = (system: string, prompt: string) => Promise<string>;

export type DraftInput = {
  premise: string;
  shots?: number;
  /** Visual style line, e.g. storybook watercolor / Pixar-like 3D / live-action drama. */
  style?: string;
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

const SYSTEM = `You are a film director writing a short vertical (9:16) AI-video story for Google Veo.
Return ONLY one JSON object, no commentary:
{"title": "...", "titleCard": {"lines": ["UP TO 2 SHORT", "UPPERCASE LINES"], "kicker": "short Indonesian tagline"},
 "characters": {"TOKEN": "full visual descriptor in English (age, look, clothing, one signature prop)"},
 "shots": [{"id": "kebab-id", "silent": true|omitted, "prompt": "...", "narration": "..."}]}
Rules (they are checked by code; violations are sent back to you):
- Shot 1 is a silent establishing intro ("silent": true, no narration) with empty open sky in the upper third for the title.
- Every other shot has "narration": ONE Indonesian sentence (or two very short ones), max ${MAX_NARRATION_WORDS} words, warm storyteller voice.
- "prompt" is English. Start with framing + exactly ONE camera move (e.g. "Medium close-up, the camera pushes in slowly."), then subject, action, setting, light.
- Never name camera gear (jib, crane, rig, dolly track, slider, gimbal, drone) — describe only the movement.
- Refer to characters ONLY by their UPPERCASE TOKEN inside prompts; the token is replaced by its descriptor, keeping them consistent.
- Real emotional arc: setup, loss or conflict, struggle, turning point, reunion or resolution, quiet ending.
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

function normalise(raw: unknown, style: string): Storyboard {
  const r = (raw ?? {}) as Record<string, unknown>;
  const shots = (Array.isArray(r.shots) ? r.shots : []) as Array<Record<string, unknown>>;
  const titleCard = r.titleCard as { lines?: unknown; kicker?: unknown } | undefined;
  return {
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
    shots: shots.map((s, i): Shot => ({
      id: `${String(i).padStart(2, '0')}-${slug(String(s.id ?? `shot-${i}`)).replace(/^\d+-/, '')}`,
      prompt: String(s.prompt ?? ''),
      ...(s.silent === true ? { silent: true } : { narration: String(s.narration ?? '').trim() })
    }))
  };
}

export async function draftStoryboard(input: DraftInput, generate: TextGenerator): Promise<Storyboard> {
  const count = Math.min(Math.max(Math.round(input.shots ?? 8), 3), 12);
  const style = input.style?.trim() ? (input.style.trim().startsWith('Style:') ? input.style.trim() : `Style: ${input.style.trim()}`) : DEFAULT_STYLE;
  const base = `Premise (Indonesian): ${input.premise.trim()}\nWrite exactly ${count} shots (6 seconds each). Visual style for every shot: ${style}`;
  let prompt = base;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reply = '';
    try {
      reply = await generate(SYSTEM, prompt);
      const board = normalise(parseJsonBlock(reply), style);
      problems = validateStoryboard(board);
      if (!problems.length) return board;
    } catch (error) {
      problems = [`reply was not valid JSON (${error instanceof Error ? error.message : String(error)})`];
    }
    prompt = `${base}\n\nYour previous storyboard broke these rules — return the corrected full JSON:\n- ${problems.join('\n- ')}${reply ? `\n\nPrevious reply:\n${reply.slice(0, 6000)}` : ''}`;
  }
  throw new Error(`Draft masih melanggar aturan setelah 3 percobaan: ${problems.join('; ')}`);
}

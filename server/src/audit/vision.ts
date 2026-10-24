/**
 * Vision audit (spec §4.4): one vision model call judges whether a take delivers what the shot
 * promised, scored 0–100 on four dimensions (method adapted from wind-comic, MIT).
 *
 * Bands: ≥75 pass, 50–74 warn, <50 fail; assembly needs ≥70 (§9). Red flags (wrong place,
 * missing subject or prop, warped hands/faces, any text or watermark) cap the score below the
 * failure band whatever the model answered — an unusable take never passes on a generous score.
 * `repair` is a single English instruction naming what is missing, ready to append to the next
 * prompt, so a retry fixes the shot instead of re-rolling the dice.
 *
 * Images are sent as base64 data URLs, at most three: the take first, then references.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sniffMediaType } from '../lib/media-type.js';
import { openRouterJson, type FetchLike } from '../providers/client.js';

export const AUDIT_GATE = 70;
export const PASS_SCORE = 75;
export const WARN_SCORE = 50;
export const MAX_AUDIT_IMAGES = 3;
/** A red flag is a hard fail: the take is unusable however kind the model was. */
export const RED_FLAG_CAP = 45;

export type AuditDimension = 'sceneMatch' | 'actionMatch' | 'moodMatch' | 'composition';
export const DIMENSIONS: readonly AuditDimension[] = ['sceneMatch', 'actionMatch', 'moodMatch', 'composition'];
export type AuditDimensions = Record<AuditDimension, number>;

/** What the shot promised. Text only; the take itself carries the pixels. */
export type AuditExpectation = {
  scene?: string;
  action?: string;
  mood?: string;
  /** Spoken line: audio, never burned into the frame. */
  dialogue?: string;
};

export type AuditResult = {
  score: number;
  dimensions: AuditDimensions;
  issues: string[];
  reasoning: string;
  repair: string;
  costUsd: number;
};

export type AuditBand = 'pass' | 'warn' | 'fail';

export function auditBand(score: number): AuditBand {
  if (score >= PASS_SCORE) return 'pass';
  return score >= WARN_SCORE ? 'warn' : 'fail';
}

/** Does this score clear the assembly gate? An unaudited shot has no score, so it does not answer this. */
export const clearsGate = (score: number | undefined): boolean => score !== undefined && score >= AUDIT_GATE;

/** The model answered, but not with an audit. Never treated as a pass. */
export class AuditParseError extends Error {
  override readonly name = 'AuditParseError';
  constructor(detail: string) {
    super(`Balasan audit tidak bisa dibaca: ${detail}`);
  }
}

/**
 * Red flags: the wrong place, a missing subject/prop, warped hands or faces, any text/watermark.
 * A negated issue ("no text or watermark") describes a clean frame and is not a flag.
 */
const RED_FLAGS: Array<{ label: string; re: RegExp }> = [
  { label: 'off-scene', re: /\b(?:off[- ]?scene|wrong (?:location|place|setting)|bukan lokasi)\b/i },
  { label: 'missing subject', re: /\bmissing (?:the )?(?:subject|character|person|cat|child|prop|object)\b|\b(?:no|without) (?:the )?(?:subject|character|prop)\b/i },
  { label: 'warped hands/faces', re: /\b(?:warped|deformed|melted|distorted|extra|broken) (?:fingers?|hands?|faces?|eyes?|limbs?)\b/i },
  { label: 'text/watermark', re: /\b(?:text|lettering|subtitles?|caption|logo|watermark)\b/i }
];

const NEGATED = /^\s*(?:no|none|without|tanpa|tidak ada)\b/i;

export function redFlags(issues: string[]): string[] {
  return issues.filter(issue => !NEGATED.test(issue.trim()) && RED_FLAGS.some(flag => flag.re.test(issue)));
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return clamp(Number(value));
  return undefined;
}

function issueList(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' ? value.split(/[\n;]+/) : [];
  return [...new Set(parts.map(p => p.trim()).filter(Boolean))].slice(0, 12);
}

/** `repair` when the model left it empty: one instruction that names every issue. */
export function repairFrom(issues: string[]): string {
  if (!issues.length) return '';
  return `Fix exactly this and keep everything else unchanged: ${issues.join('; ')}.`;
}

/** The first JSON object in `text` (the model may fence it or wrap it in a sentence). */
function extractObject(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(body);
  } catch { /* fall through to the brace scan */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Model reply → audit. Missing dimensions fall back to the score; a missing score falls back to
 * the dimension average; a missing repair is derived from the issues. Unreadable = throw.
 */
export function parseAuditReply(text: string): AuditResult {
  const parsed = extractObject(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuditParseError('tidak ada JSON');
  const raw = parsed as Record<string, unknown>;
  const dimsRaw = raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions as Record<string, unknown> : {};
  const given: Partial<AuditDimensions> = {};
  for (const key of DIMENSIONS) {
    const value = numberOf(dimsRaw[key]);
    if (value !== undefined) given[key] = value;
  }
  const known = Object.values(given) as number[];
  const score = numberOf(raw.score) ?? (known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : undefined);
  if (score === undefined) throw new AuditParseError('tanpa skor');
  const dimensions = {} as AuditDimensions;
  for (const key of DIMENSIONS) dimensions[key] = given[key] ?? score;
  const issues = issueList(raw.issues);
  const repair = typeof raw.repair === 'string' && raw.repair.trim() ? raw.repair.trim() : repairFrom(issues);
  return {
    score: redFlags(issues).length ? Math.min(score, RED_FLAG_CAP) : score,
    dimensions,
    issues,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '',
    repair,
    costUsd: 0
  };
}

const SYSTEM = [
  'You are a film continuity auditor. You receive one take of a single shot — a still keyframe, or frames sampled in time order from the rendered clip — and, when present, reference images of the cast and look dev. Judge whether the take delivers the shot.',
  'Answer with JSON only, no prose.',
  '',
  'score: 0-100 for how well the take delivers the expectation. 75-100 passes, 50-74 needs a fix, below 50 is unusable.',
  'dimensions (each 0-100):',
  '- sceneMatch: the right place, time of day, set dressing and props.',
  '- actionMatch: the described action is happening, done by the right subject, in the right direction.',
  '- moodMatch: the emotion, light and tone of the expectation.',
  '- composition: framing and subject size, headroom, nothing important cropped, a clean silhouette.',
  '',
  'Red flags that always fail a take: the wrong location; a missing subject or prop; warped hands or faces; any text, letters, subtitles, logo or watermark.',
  '',
  'issues: concrete and short, most important first ("the wooden gate is missing"). Never invent a problem.',
  'repair: one instruction in English that names exactly what is missing or wrong and tells the image model what to add or change. It is appended to the next prompt, so it must stand alone ("The wooden gate is missing: add a weathered wooden gate across the lower third"). Empty when nothing needs fixing.',
  'reasoning: one short sentence.',
  '',
  'Reply shape: {"score":78,"dimensions":{"sceneMatch":80,"actionMatch":75,"moodMatch":85,"composition":72},"issues":[],"reasoning":"The gate and the cat are both in frame.","repair":""}'
].join('\n');

export function auditExpectationText(expectation: AuditExpectation): string {
  return [
    expectation.scene ? `Setting: ${expectation.scene}` : '',
    expectation.action ? `Action: ${expectation.action}` : '',
    expectation.mood ? `Mood: ${expectation.mood}` : '',
    expectation.dialogue ? `Spoken line (voice-over; must not appear as on-screen text): "${expectation.dialogue}"` : ''
  ].filter(Boolean).join('\n');
}

/**
 * The system + user text of one audit. `frameCount` says how many leading images are the take
 * itself (1 for a keyframe, up to 3 for sampled clip frames); later images are references.
 */
export function auditPrompt(expectation: AuditExpectation, imageCount: number, frameCount = 1): { system: string; user: string } {
  const takes = Math.max(1, Math.min(frameCount, imageCount));
  const takeLine = takes === 1 ? 'Image 1 is the take.' : `Images 1-${takes} are frames of the take, sampled in time order from one clip.`;
  const refLine = imageCount === takes + 1
    ? `Image ${takes + 1} is a reference (character sheet, look dev): check identity and look against it, never score the reference.`
    : imageCount > takes
      ? `Images ${takes + 1}-${imageCount} are references (character sheet, look dev): check identity and look against them, never score the references.`
      : '';
  const user = [
    'Shot under review:',
    auditExpectationText(expectation) || '(no written expectation)',
    takeLine,
    refLine,
    'Return only the JSON object.'
  ].filter(Boolean).join('\n');
  return { system: SYSTEM, user };
}

async function dataUrl(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  const type = sniffMediaType(file);
  if (!type.startsWith('image/')) return undefined;
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}

export type AuditShotInput = {
  /** Local files: the take first, then references. At most three are sent. */
  images: string[];
  expectation: AuditExpectation;
  model: string;
  apiKey: string;
  fetch: FetchLike;
  /** How many leading images are frames of the take (keyframe = 1, sampled clip = 3). */
  frameCount?: number;
  timeoutMs?: number;
};

type ChatReply = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { cost?: unknown };
};

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
};

/** One audit call: images → OpenRouter vision → parsed audit (with the real usage cost). */
export async function auditShot(input: AuditShotInput): Promise<AuditResult> {
  const files: string[] = [];
  for (const file of input.images.slice(0, MAX_AUDIT_IMAGES * 2)) {
    if (!file || !existsSync(file)) continue;
    files.push(file);
    if (files.length === MAX_AUDIT_IMAGES) break;
  }
  if (!files.length) throw new Error('Audit butuh minimal satu gambar');
  const urls = (await Promise.all(files.map(dataUrl))).filter((u): u is string => !!u);
  if (!urls.length) throw new Error('Audit butuh minimal satu gambar');
  const frameCount = Math.max(1, Math.min(input.frameCount ?? 1, urls.length));
  const { system, user } = auditPrompt(input.expectation, urls.length, frameCount);
  const body = await openRouterJson<ChatReply>(input.fetch, input.apiKey, '/chat/completions', {
    body: {
      model: input.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      usage: { include: true },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text: user }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] }
      ]
    },
    timeoutMs: input.timeoutMs ?? 90_000
  });
  const content = contentText(body.choices?.[0]?.message?.content);
  if (!content.trim()) throw new AuditParseError('balasan kosong');
  const audit = parseAuditReply(content);
  const cost = typeof body.usage?.cost === 'number' && Number.isFinite(body.usage.cost) ? body.usage.cost : 0;
  return { ...audit, costUsd: cost };
}

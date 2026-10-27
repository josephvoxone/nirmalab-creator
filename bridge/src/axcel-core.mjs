/**
 * Pure helpers for the Axcel bridge (no network, no Chrome) — the parts worth testing.
 *
 * Axcel (`axcel.cloud`) is an Indonesian reseller front-end (Seedance / Veo / Nano Banana /
 * Seedream). There is no public API: the web app talks to `/api/*` on the same origin and every
 * call carries
 *   - the session cookie `axcel_sesi` (HttpOnly),
 *   - `X-Axcel-Klien: web`,
 *   - `X-Axcel-Token` — a page token minted from a Cloudflare Turnstile solve (30 min), and
 *   - for `POST /api/generate`, a second Turnstile token inside the JSON body (`turnstile`,
 *     solved with action `generate`, single use).
 * Only a real browser session can produce those tokens, so the bridge runs on the Mac next to the
 * logged-in Chrome and mints them per request.
 */

export const AXCEL_ORIGIN = 'https://axcel.cloud';
export const CLIENT_HEADER = { 'X-Axcel-Klien': 'web' };

/** Storyboard aspect → Axcel ratio. Axcel takes the six the models list. */
export const RATIOS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];

/** Axcel rejects anything else on video; images ignore it. */
export const VIDEO_RESOLUTIONS = [480, 720, 1080];

/** One page token lives 30 min server-side; refresh a minute early. */
export const PAGE_TOKEN_TTL_MS = 29 * 60_000;

/**
 * Operation for a job: an image with references is an edit (`i2i`), a clip with a keyframe is
 * `i2v`, otherwise text-only (`t2v` / `t2i`).
 */
export function axcelOp({ kind, hasStart = false, hasReferences = false }) {
  if (kind === 'image') return hasReferences ? 'i2i' : 't2i';
  return hasStart ? 'i2v' : 't2v';
}

/** `resolution` as a number (the API takes 480, not '480p'). */
export function resolutionNumber(value, fallback = 480) {
  const n = typeof value === 'string' ? Number(value.replace(/p$/i, '')) : Number(value);
  return VIDEO_RESOLUTIONS.includes(n) ? n : fallback;
}

/**
 * `duration` in seconds: the model's supported list picks the closest value to the job's request
 * (ties go to the longer clip so narration fits); unknown lists pass the request through clamped
 * to Axcel's 5–30 s window.
 */
export function pickDuration(requested, supported) {
  const want = Number.isFinite(requested) && requested > 0 ? requested : 5;
  const list = Array.isArray(supported) ? supported.filter(d => Number.isFinite(d) && d > 0) : [];
  if (!list.length) return Math.min(30, Math.max(5, Math.round(want)));
  return list.reduce((best, d) => {
    const diff = Math.abs(d - want) - Math.abs(best - want);
    return diff < 0 || (diff === 0 && d > best) ? d : best;
  });
}

/**
 * The exact body `POST /api/generate` expects (captured from the web app):
 * `{model, op, prompt, duration, resolution, ratio, audio, inputs, idempotencyKey, bahasa, turnstile}`.
 * Image jobs carry no duration/resolution.
 */
export function axcelPayload({
  model, op, prompt, ratio = '9:16', duration, resolution, audio = false,
  inputs = {}, idempotencyKey, turnstile, bahasa = 'id'
}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('model is required');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('idempotencyKey is required');
  if (typeof turnstile !== 'string' || !turnstile.trim()) throw new Error('turnstile is required');
  const body = {
    model,
    op,
    prompt,
    ratio: RATIOS.includes(ratio) ? ratio : '9:16',
    audio: audio === true,
    inputs,
    idempotencyKey,
    bahasa,
    turnstile
  };
  if (op !== 't2i' && op !== 'i2i') {
    body.duration = duration;
    body.resolution = resolution;
  }
  return body;
}

/** Turn an Axcel error payload into a message + whether retrying can help. */
export function classifyAxcelError(status, payload) {
  const detail = payload && typeof payload === 'object' ? payload.detail ?? payload : payload;
  const code = detail && typeof detail === 'object' ? detail.code : undefined;
  const message = detail && typeof detail === 'object'
    ? String(detail.message ?? code ?? '')
    : typeof detail === 'string' ? detail : '';
  const final = [400, 402, 403, 404, 413, 422].includes(status)
    && !['TURNSTILE', 'TOKEN_HALAMAN', 'KLIEN_TIDAK_DIKENAL'].includes(code);
  // Cloudflare/nginx error pages arrive as HTML; keep them out of job messages.
  const text = !message || message.trimStart().startsWith('<') ? `Axcel membalas ${status}` : message;
  return { final, code, message: code && !text.includes(code) ? `${code}: ${text}` : text };
}

/** Terminal job states: done pays out, the rest are failures with a reason. */
export function jobState(status) {
  if (status === 'done') return 'done';
  if (['error', 'gagal', 'failed', 'canceled', 'cancelled'].includes(status)) return 'failed';
  return 'running';
}

/** Extension of the saved file for a job result. */
export const resultExtension = kind => (kind === 'video' ? 'mp4' : 'png');

/** `a=b; c=d` from CDP cookie objects, ready for a Cookie header. */
export function cookieHeader(cookies, host = 'axcel.cloud') {
  return (Array.isArray(cookies) ? cookies : [])
    .filter(c => c && typeof c.name === 'string' && typeof c.value === 'string')
    .filter(c => {
      const domain = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
      return domain === host || host.endsWith(`.${domain}`);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/** Signed media path → absolute URL (`/api/media/x.mp4?k=…` → `https://axcel.cloud/...`). */
export function absoluteMediaUrl(resultUrl) {
  if (typeof resultUrl !== 'string' || !resultUrl) return undefined;
  if (/^https?:\/\//i.test(resultUrl)) return resultUrl;
  return `${AXCEL_ORIGIN}${resultUrl.startsWith('/') ? '' : '/'}${resultUrl}`;
}

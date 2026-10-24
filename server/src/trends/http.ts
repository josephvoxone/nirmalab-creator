/**
 * The one HTTP helper the trend sources share.
 *
 * Sources must FAIL SOFT (spec §9.7): a platform being down, rate-limited or answering a
 * shape we do not understand yields `{ ok: false }` and zero items, never an exception that
 * reaches the route. That is the whole point of the type — callers cannot accidentally throw
 * because there is nothing to throw.
 */
export type FetchLike = typeof fetch;

export type JsonResult = { ok: true; body: unknown } | { ok: false; error: string };

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** GET `url` and parse JSON. Never throws; a non-2xx or unparseable body is `ok: false`. */
export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000)
    });
  } catch (error) {
    return { ok: false, error: detail(error) };
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch (error) {
    return { ok: false, error: `bad JSON: ${detail(error)}` };
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Tolerant number: numbers, numeric strings, and null/undefined → `fallback`. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Tolerant string: trims, and never returns `undefined`. */
export function str(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

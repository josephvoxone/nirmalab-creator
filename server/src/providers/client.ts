/** Minimal OpenRouter HTTP client: auth header, Indonesian error messages, never logs the key. */
import { OPENROUTER_API } from './catalog.js';

export type FetchLike = typeof fetch;
export type OpenRouterBalance = { usedUsd: number; limitUsd: number | null; remainingUsd: number | null };

export class OpenRouterError extends Error {
  /** final = retrying the same request cannot help (bad key, no balance, rejected input). */
  constructor(message: string, readonly status: number, readonly final: boolean) {
    super(message);
  }
}

export function errorFor(status: number, detail: string): OpenRouterError {
  if (status === 401 || status === 403) return new OpenRouterError('API key OpenRouter ditolak', status, true);
  if (status === 402) return new OpenRouterError('Saldo OpenRouter habis', status, true);
  const retryable = status === 408 || status === 429 || status >= 500;
  const suffix = detail ? `: ${detail.slice(0, 200)}` : '';
  return new OpenRouterError(`OpenRouter menolak permintaan (HTTP ${status})${suffix}`, status, !retryable);
}

async function detailOf(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
      return typeof message === 'string' ? message : '';
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return '';
  }
}

export async function openRouterRequest(
  fetchImpl: FetchLike, apiKey: string, path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(path.startsWith('http') ? path : `${OPENROUTER_API}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-title': 'Nirmalab Creator'
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 120_000)
    });
  } catch (error) {
    throw new OpenRouterError(`OpenRouter tidak bisa dihubungi: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), 0, false);
  }
  if (!res.ok) throw errorFor(res.status, await detailOf(res));
  return res;
}

export async function openRouterJson<T>(fetchImpl: FetchLike, apiKey: string, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const res = await openRouterRequest(fetchImpl, apiKey, path, init);
  try {
    return (await res.json()) as T;
  } catch {
    throw new OpenRouterError('Balasan OpenRouter tidak bisa dibaca', res.status, false);
  }
}

const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** GET /key → usage / limit / limit_remaining in USD. */
export async function keyBalance(fetchImpl: FetchLike, apiKey: string): Promise<OpenRouterBalance> {
  const body = await openRouterJson<{ data?: { usage?: unknown; limit?: unknown; limit_remaining?: unknown } }>(fetchImpl, apiKey, '/key', { timeoutMs: 20_000 });
  return { usedUsd: money(body.data?.usage) ?? 0, limitUsd: money(body.data?.limit), remainingUsd: money(body.data?.limit_remaining) };
}

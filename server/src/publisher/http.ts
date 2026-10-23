import { PublisherError, type FetchLike } from './types.js';

export class PublisherHttpError extends PublisherError {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(host: string, status: number, bodySnippet: string) {
    super('UPSTREAM_ERROR', `${host} returned HTTP ${status}: ${bodySnippet}`);
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function errorSnippet(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as { error?: { message?: unknown; error_description?: unknown }; error_description?: unknown; message?: unknown };
    const message = maybe.error?.message ?? maybe.error?.error_description ?? maybe.error_description ?? maybe.message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
    try {
      return JSON.stringify(payload).slice(0, 300);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  timeoutMs = 30_000
): Promise<unknown> {
  const host = new URL(url).host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    });
    const payload = await readJsonSafe(response);
    if (!response.ok) throw new PublisherHttpError(host, response.status, errorSnippet(payload, 'request failed'));
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 30_000
): Promise<{ response: Response; payload: unknown }> {
  const host = new URL(url).host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await readJsonSafe(response);
    if (!response.ok) throw new PublisherHttpError(host, response.status, errorSnippet(payload, 'request failed'));
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 30_000
): Promise<unknown> {
  const host = new URL(url).host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const payload = await readJsonSafe(response);
    if (!response.ok) throw new PublisherHttpError(host, response.status, errorSnippet(payload, 'request failed'));
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

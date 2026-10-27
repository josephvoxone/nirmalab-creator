/**
 * Server-sent events over a POST (EventSource only does GET): the body is read with a
 * TextDecoder, blocks are split on blank lines, `event:`/`data:` lines are joined, `:` comment
 * lines (the server's `: ping` keep-alive) are skipped. A non-2xx answer before the stream is
 * read as the JSON error and thrown as an ApiError, so callers show it like any other failure.
 */
import { ApiError, type FetchLike } from '../../lib/api.js';

export type SseEvent = { event: string; data: unknown };

/** Incremental parser: feed it text as it arrives, it returns the events completed so far. */
export function sseParser() {
  let buffer = '';
  const parseBlock = (block: string): SseEvent | undefined => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return undefined;
    const text = data.join('\n');
    try { return { event, data: JSON.parse(text) }; } catch { return { event, data: text }; }
  };
  // A chunk that ends in '\r' may be the first half of a CRLF: hold it until the next chunk.
  let heldCr = false;
  return {
    push(chunk: string): SseEvent[] {
      let text = (heldCr ? '\r' : '') + chunk;
      heldCr = text.endsWith('\r');
      if (heldCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      const out: SseEvent[] = [];
      let at: number;
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const parsed = parseBlock(block);
        if (parsed) out.push(parsed);
      }
      return out;
    },
    /** Whatever is left when the stream ends without a final blank line. */
    flush(): SseEvent[] {
      const rest = (buffer + (heldCr ? '\n' : '')).trim();
      buffer = '';
      heldCr = false;
      const parsed = rest ? parseBlock(rest) : undefined;
      return parsed ? [parsed] : [];
    }
  };
}

/** POST `body` as JSON and call `onEvent` for every event until the stream ends or `signal` aborts. */
export async function postSse(fetchImpl: FetchLike, url: string, body: unknown, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    let payload: { error?: { message?: string; code?: string } } | undefined;
    try { payload = await response.json(); } catch { payload = undefined; }
    throw new ApiError(response.status, payload?.error?.message ?? `Permintaan gagal (${response.status})`, payload?.error?.code);
  }
  if (!response.body) throw new ApiError(response.status, 'Jawaban asisten kosong — coba lagi.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = sseParser();
  // A body that ignores the signal (some proxies, test doubles) still stops reading on Stop.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
    }
    if (signal?.aborted) throw new DOMException('Dihentikan', 'AbortError');
    for (const e of parser.push(decoder.decode())) onEvent(e);
    for (const e of parser.flush()) onEvent(e);
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock?.();
  }
}

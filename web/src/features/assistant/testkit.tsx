/** Test helpers for the assistant panel: a fake API whose POSTs answer with a stream the test drives. */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { Turn } from './assistantClient.js';

export const SID = 'story_0123456789abcdef';

/** One SSE event as the server writes it. */
export const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export type Stream = { push: (text: string) => void; end: () => void; signal?: AbortSignal; body: Record<string, unknown> };

export type AssistantCall = { method: string; url: string; body?: Record<string, unknown>; raw?: unknown; headers?: Record<string, string>; signal?: AbortSignal };

export function fakeAssistantApi(opts: {
  turns?: Turn[]; configured?: boolean; historyFail?: boolean;
  /** Hold the first GET until `releaseHistory()` (skeleton test). */
  holdHistory?: boolean;
  /** Answer a POST before streaming (e.g. a 409) — return undefined to stream. */
  refuse?: (body: Record<string, unknown>) => Response | undefined;
  undo?: (undoId: string) => Response;
  /** Hold every upload until `releaseUploads(status)`; the fake ignores the signal (a slow proxy). */
  holdUploads?: boolean;
} = {}) {
  let releaseUpload: (status: number) => void = () => undefined;
  let uploadHeld = new Promise<number>(r => { releaseUpload = r; });
  const calls: AssistantCall[] = [];
  const streams: Stream[] = [];
  let turns = opts.turns ?? [];
  let configured = opts.configured ?? true;
  let release: () => void = () => undefined;
  const held = new Promise<void>(r => { release = r; });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let uploads = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, url, body, raw: init?.body, headers: init?.headers as Record<string, string> | undefined, signal: init?.signal ?? undefined });
    const base = `/api/stories/${SID}/assistant`;
    if (url === base && method === 'GET') {
      if (opts.holdHistory && calls.filter(c => c.url === base && c.method === 'GET').length === 1) await held;
      if (opts.historyFail) return json(500, { error: { message: 'disk penuh' } });
      return json(200, { turns, configured });
    }
    if (url === base && method === 'POST') {
      const refused = opts.refuse?.(body ?? {});
      if (refused) return refused;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
      const enc = new TextEncoder();
      const signal = init?.signal ?? undefined;
      let closed = false;
      signal?.addEventListener('abort', () => { if (!closed) { closed = true; ctrl.error(new DOMException('Aborted', 'AbortError')); } });
      streams.push({
        body: body ?? {}, signal,
        push: text => ctrl.enqueue(enc.encode(text)),
        end: () => { if (!closed) { closed = true; ctrl.close(); } }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const undo = new RegExp(`^${base}/undo/(.+)$`).exec(url);
    if (undo && method === 'POST') return opts.undo?.(decodeURIComponent(undo[1]!)) ?? json(200, { ok: true, rev: 9, attention: [] });
    if (url === `/api/stories/${SID}/uploads` && method === 'POST') {
      uploads++;
      if (opts.holdUploads) {
        const status = await uploadHeld;
        if (status !== 201) return json(status, { error: { message: 'Unggahan gagal di server' } });
      }
      return json(201, { id: `up_${String(uploads).padStart(16, '0')}`, url: `/api/stories/${SID}/uploads/up_${uploads}.png`, w: 1024, h: 1536, bytes: 2048 });
    }
    return json(404, { error: { message: `no fake for ${method} ${url}` } });
  });
  return {
    fetchImpl, calls, streams,
    releaseHistory: () => release(),
    releaseUploads: (status = 201) => { releaseUpload(status); uploadHeld = new Promise<number>(r => { releaseUpload = r; }); },
    setTurns: (t: Turn[]) => { turns = t; },
    setConfigured: (v: boolean) => { configured = v; },
    posts: () => calls.filter(c => c.method === 'POST' && c.url === `/api/stories/${SID}/assistant`)
  };
}

export function mountWith(ui: ReactNode, fetchImpl: ReturnType<typeof fakeAssistantApi>['fetchImpl']) {
  return render(
    <SessionContext.Provider value={{ user: { id: 'u1', email: 'a@x.io', isAdmin: true }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={[`/cerita/${SID}`]}>
        <Routes>
          <Route path="/cerita/:id" element={ui} />
          <Route path="/pengaturan/:tab" element={<p>halaman pengaturan</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

export function mockMatchMedia(matches: (query: string) => boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches(query), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}

export const turn = (over: Partial<Turn> & Pick<Turn, 'id' | 'role' | 'text'>): Turn => ({ at: '2026-10-27T10:00:00.000Z', ...over });

/** A working localStorage for one test (this jsdom origin has none); returns the restore. */
export function memoryStorage(opts: { blocked?: boolean } = {}) {
  const had = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const data = new Map<string, string>();
  const fail = () => { throw new Error('storage blocked'); };
  const store = {
    getItem: (k: string) => (opts.blocked ? fail() : data.get(k) ?? null),
    setItem: (k: string, v: string) => (opts.blocked ? fail() : void data.set(k, String(v))),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; }
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  return {
    store,
    restore: () => { if (had) Object.defineProperty(window, 'localStorage', had); else delete (window as { localStorage?: unknown }).localStorage; }
  };
}

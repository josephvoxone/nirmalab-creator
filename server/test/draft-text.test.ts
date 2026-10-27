import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { LlmError, type ChatInput, type TextModel } from '../src/llm/opencode.js';
import { draftStoryboard } from '../src/stories/draft.js';
import { draftTextGenerator } from '../src/stories/draft-text.js';

const draftBoard = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' },
    { id: '02-b', prompt: 'Wide shot of a girl walking home with the kitten.', narration: 'Mereka pulang.' }
  ]
};

function fakeModel(reply: (input: ChatInput) => Promise<string>): TextModel & { calls: ChatInput[] } {
  const calls: ChatInput[] = [];
  return {
    calls,
    configured: async () => true,
    chat: async input => { calls.push(input); return { message: { role: 'assistant', content: await reply(input) }, model: 'glm-5.3-flash' }; }
  };
}
const failingModel = (code: 'NOT_CONFIGURED' | 'UNAVAILABLE'): TextModel => ({
  configured: async () => code !== 'NOT_CONFIGURED',
  chat: async () => { throw new LlmError(code, 'no'); }
});

describe('draftTextGenerator', () => {
  it('uses the text model (one system + one user message, no tools) when it answers', async () => {
    const model = fakeModel(async () => 'dari model');
    const fallback = vi.fn(async () => 'dari pollinations');
    const signal = new AbortController().signal;
    expect(await draftTextGenerator(model, fallback)('SYS', 'PROMPT', signal)).toBe('dari model');
    expect(fallback).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'PROMPT' }]);
    expect(model.calls[0]!.tools).toBeUndefined();
    expect(model.calls[0]!.signal).toBe(signal);
  });

  it('falls back to Pollinations on NOT_CONFIGURED and UNAVAILABLE', async () => {
    for (const code of ['NOT_CONFIGURED', 'UNAVAILABLE'] as const) {
      const fallback = vi.fn(async () => 'dari pollinations');
      expect(await draftTextGenerator(failingModel(code), fallback)('SYS', 'PROMPT'), code).toBe('dari pollinations');
      expect(fallback).toHaveBeenCalledWith('SYS', 'PROMPT', undefined);
    }
    const fallback = vi.fn(async () => 'dari pollinations');
    expect(await draftTextGenerator(undefined, fallback)('SYS', 'PROMPT')).toBe('dari pollinations');
  });
});

describe('draftStoryboard abort', () => {
  it('stops at once when the signal is aborted (no retries)', async () => {
    const controller = new AbortController();
    let calls = 0;
    const run = draftStoryboard({ premise: 'Kucing hilang lalu pulang', shots: 3 }, async () => { calls++; controller.abort(); return 'bukan json'; }, { signal: controller.signal });
    await expect(run).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('app draft generator', () => {
  const open: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (open.length) await open.pop()!.close().catch(() => undefined);
  });

  let seq = 0;
  async function draftWith(model: TextModel) {
    const realFetch = globalThis.fetch;
    const pollinations: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.includes('pollinations')) {
        pollinations.push(href);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draftBoard) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    });
    const email = `draft-text${++seq}@x.io`;
    const server = await buildApp({
      dataDir: mkdtempSync(join(tmpdir(), 'nc-draft-text-')),
      env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0 },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 },
      text: { model }
    });
    open.push(server);
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await server.inject({ method: 'POST', url: '/api/stories/draft', headers: { cookie }, payload: { premise: 'Kucing hilang lalu pulang', shots: 3 } });
    return { res, pollinations };
  }

  it('drafts with the configured text model; Pollinations is not called', async () => {
    const model = fakeModel(async () => JSON.stringify(draftBoard));
    const { res, pollinations } = await draftWith(model);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().story.title).toBe('Kucing Hilang');
    expect(model.calls.length).toBeGreaterThanOrEqual(1);
    expect(pollinations).toEqual([]);
  });

  it('without a key (NOT_CONFIGURED) drafts with Pollinations as before', async () => {
    const { res, pollinations } = await draftWith(failingModel('NOT_CONFIGURED'));
    expect(res.statusCode, res.body).toBe(201);
    expect(pollinations.length).toBeGreaterThanOrEqual(1);
  });
});

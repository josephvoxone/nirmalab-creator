import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { DEFAULT_TEXT_MODEL, TEXT_MODELS, TextModelConfigStore } from '../src/llm/config.js';
import { LlmError, TEXT_CHAIN, createOpenCodeModel, type TextModel } from '../src/llm/opencode.js';
import { registerProviderRoutes } from '../src/providers/routes.js';

const KEY = 'fake-opencode-key-0000wxyz';
const URL_CHAT = 'https://opencode.ai/zen/go/v1/chat/completions';
const SESSION = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

type Call = { url: string; headers: Headers; body: Record<string, unknown> };
const ok = (model: string, content = 'halo') => new Response(JSON.stringify({
  model, choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 12 }
}), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response(JSON.stringify({ error: { message: `upstream ${code}` } }), { status: code });

function fakeFetch(reply: (model: string, call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    return reply(String(call.body.model), call, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function storeWithKey(model?: string) {
  const store = new TextModelConfigStore(mkdtempSync(join(tmpdir(), 'nc-llm-')));
  await store.patch({ apiKey: KEY, ...(model ? { model } : {}) });
  return store;
}

const user = [{ role: 'user' as const, content: 'Halo' }];

/** A promise that only settles (rejects) when the request's signal aborts — a stalled fetch or body read. */
const hangUntilAbort = <T>(signal?: AbortSignal | null) => new Promise<T>((_resolve, reject) => {
  const fail = () => reject(new DOMException('aborted', 'AbortError'));
  if (signal?.aborted) fail();
  else signal?.addEventListener('abort', fail, { once: true });
});

describe('OpenCode Go text model', () => {
  it('posts to the Go endpoint with bearer key, a User-Agent and a fresh session id per request', async () => {
    const f = fakeFetch(model => ok(model));
    const model = createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl });
    const first = await model.chat({ messages: user, maxTokens: 50 });
    await model.chat({ messages: user });
    expect(first).toEqual({ message: { role: 'assistant', content: 'halo' }, model: 'glm-5.3-flash', usage: { total_tokens: 12 } });
    expect(f.calls).toHaveLength(2);
    const [a, b] = f.calls;
    expect(a!.url).toBe(URL_CHAT);
    expect(a!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(a!.headers.get('user-agent')).toBeTruthy();
    expect(a!.headers.get('x-opencode-session')).toMatch(SESSION);
    expect(b!.headers.get('x-opencode-session')).toMatch(SESSION);
    expect(a!.headers.get('x-opencode-session')).not.toBe(b!.headers.get('x-opencode-session'));
    expect(a!.body).toMatchObject({ model: 'glm-5.3-flash', messages: user, max_tokens: 50 });
  });

  it('passes tools through and returns tool calls from the reply', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'list_scenes', arguments: '{}' } }];
    const f = fakeFetch(() => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] })));
    const tools = [{ type: 'function' as const, function: { name: 'list_scenes', description: 'Daftar scene', parameters: { type: 'object', properties: {} } } }];
    const out = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user, tools });
    expect(f.calls[0]!.body.tools).toEqual(tools);
    expect(out.message).toEqual({ role: 'assistant', content: '', tool_calls: toolCalls });
  });

  it('on 429 for glm-5.3-flash (default) falls back to glm-5.3, then beam-free', async () => {
    const f = fakeFetch(model => (model === 'beam-free' ? ok(model, 'dari beam') : status(429)));
    const out = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user });
    expect(f.calls.map(c => c.body.model)).toEqual(['glm-5.3-flash', 'glm-5.3', 'beam-free']);
    expect(out.model).toBe('beam-free');
    expect(out.message.content).toBe('dari beam');
    const sessions = f.calls.map(c => c.headers.get('x-opencode-session'));
    expect(new Set(sessions).size).toBe(3);
  });

  it('falls through on 5xx, network errors and timeouts', async () => {
    const f = fakeFetch((model, _call, init) => {
      if (model === 'glm-5.3-flash') return status(503);
      if (model === 'glm-5.3') throw new TypeError('fetch failed');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const model = createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl, models: ['glm-5.3-flash', 'glm-5.3', 'beam-free', 'deepseek-v4-pro'], timeoutMs: 20 });
    await expect(model.chat({ messages: user })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.calls.map(c => c.body.model)).toEqual(['glm-5.3-flash', 'glm-5.3', 'beam-free', 'deepseek-v4-pro']);
  });

  it('all models failing throws LlmError UNAVAILABLE with a plain Indonesian message', async () => {
    const f = fakeFetch(() => status(429));
    const err = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user }).catch((e: unknown) => e) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/model teks/i);
    expect(err.message).not.toContain(KEY);
    expect(f.calls).toHaveLength(3);
  });

  it('a rejected key (401) stops at once without trying other models', async () => {
    const f = fakeFetch(() => status(401));
    const err = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user }).catch((e: unknown) => e) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/key/i);
    expect(err.message).not.toContain(KEY);
    expect(f.calls).toHaveLength(1);
  });

  it('a malformed 200 is a BAD_RESPONSE once every model answered nonsense', async () => {
    const f = fakeFetch(() => new Response('{"choices":[]}', { status: 200 }));
    await expect(createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    expect(f.calls).toHaveLength(3);
  });

  it('tries the chosen model first, then the rest of the chain without duplicates', async () => {
    const glm = fakeFetch(() => status(429));
    await createOpenCodeModel({ store: await storeWithKey('glm-5.3'), fetch: glm.fetchImpl }).chat({ messages: user }).catch(() => undefined);
    expect(glm.calls.map(c => c.body.model)).toEqual(['glm-5.3', 'glm-5.3-flash', 'beam-free']);
    const deepseek = fakeFetch(() => status(500));
    await createOpenCodeModel({ store: await storeWithKey('deepseek-v4-pro'), fetch: deepseek.fetchImpl }).chat({ messages: user }).catch(() => undefined);
    expect(deepseek.calls.map(c => c.body.model)).toEqual(['deepseek-v4-pro', 'glm-5.3-flash', 'glm-5.3', 'beam-free']);
  });

  it('403 and 404 stop after one call', async () => {
    for (const code of [403, 404]) {
      const f = fakeFetch(() => status(code));
      await expect(createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(f.calls).toHaveLength(1);
    }
  });

  it('an already-aborted signal rejects without calling fetch', async () => {
    const f = fakeFetch(model => ok(model));
    const caller = new AbortController();
    caller.abort();
    await expect(createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user, signal: caller.signal }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Permintaan ke model teks dibatalkan.' });
    expect(f.calls).toHaveLength(0);
  });

  it('an abort while the reply body is read rejects after one call and never tries the next model', async () => {
    const caller = new AbortController();
    const f = fakeFetch((model, _call, init) => {
      if (f.calls.length > 1) return ok(model);
      setTimeout(() => caller.abort(), 5);
      return { status: 200, ok: true, json: () => hangUntilAbort(init?.signal) } as unknown as Response;
    });
    await expect(createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user, signal: caller.signal }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Permintaan ke model teks dibatalkan.' });
    expect(f.calls).toHaveLength(1);
  });

  it('a timeout while the reply body is read counts as a timeout, not a bad response', async () => {
    const f = fakeFetch((_model, _call, init) => ({ status: 200, ok: true, json: () => hangUntilAbort(init?.signal) } as unknown as Response));
    const err = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl, timeoutMs: 20 }).chat({ messages: user }).catch((e: unknown) => e) as LlmError;
    expect(err).toMatchObject({ code: 'UNAVAILABLE' });
    expect(err.message).toMatch(/tidak menjawab/);
    expect(f.calls).toHaveLength(3);
  });

  it('leaves tool_calls off the message when none of them is well-formed', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'x', tool_calls: [{ bogus: 1 }] } }] })));
    const out = await createOpenCodeModel({ store: await storeWithKey(), fetch: f.fetchImpl }).chat({ messages: user });
    expect('tool_calls' in out.message).toBe(false);
  });

  it('fallback: false tries only the chosen model, with the per-call timeout', async () => {
    const limited = fakeFetch(() => status(429));
    await expect(createOpenCodeModel({ store: await storeWithKey('glm-5.3-flash'), fetch: limited.fetchImpl }).chat({ messages: user, fallback: false }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(limited.calls.map(c => c.body.model)).toEqual(['glm-5.3-flash']);
    const hanging = fakeFetch((_model, _call, init) => hangUntilAbort(init?.signal));
    const err = await createOpenCodeModel({ store: await storeWithKey(), fetch: hanging.fetchImpl, timeoutMs: 60_000 })
      .chat({ messages: user, fallback: false, timeoutMs: 20 }).catch((e: unknown) => e) as LlmError;
    expect(err.message).toMatch(/tidak menjawab/);
    expect(hanging.calls).toHaveLength(1);
  });

  it('without a key: configured() is false and chat throws NOT_CONFIGURED without calling fetch', async () => {
    const f = fakeFetch(model => ok(model));
    const model = createOpenCodeModel({ store: new TextModelConfigStore(mkdtempSync(join(tmpdir(), 'nc-llm-'))), fetch: f.fetchImpl });
    expect(await model.configured()).toBe(false);
    await expect(model.chat({ messages: user })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('TextModelConfigStore', () => {
  it('stores the key 0600 at providers/opencode-go.json; view() shows only the last 4', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-llm-'));
    const store = new TextModelConfigStore(dataDir);
    expect(await store.view()).toEqual({ configured: false, model: 'glm-5.3-flash' });
    const view = await store.patch({ apiKey: KEY, model: 'beam-free' });
    expect(view).toEqual({ configured: true, keyHint: '••••wxyz', model: 'beam-free' });
    expect(JSON.stringify(await store.view())).not.toContain(KEY);
    const file = join(dataDir, 'providers', 'opencode-go.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(KEY);
    expect(await store.key()).toBe(KEY);
    expect(await store.patch({ apiKey: null })).toEqual({ configured: false, model: 'beam-free' });
  });

  it('refuses unknown models and malformed keys', async () => {
    const store = new TextModelConfigStore(mkdtempSync(join(tmpdir(), 'nc-llm-')));
    await expect(store.patch({ model: 'gpt-9' })).rejects.toThrow(/model/i);
    await expect(store.patch({ apiKey: 'short' })).rejects.toThrow(/key/i);
    await expect(store.patch({ apiKey: 'has space in the key 123' })).rejects.toThrow(/key/i);
    expect(TEXT_MODELS).toEqual(['glm-5.3-flash', 'glm-5.3', 'beam-free', 'deepseek-v4-pro']);
    expect(DEFAULT_TEXT_MODEL).toBe('glm-5.3-flash');
    expect(TEXT_CHAIN).toEqual(['glm-5.3-flash', 'glm-5.3', 'beam-free']);
  });
});

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function routes(model?: TextModel, fetchImpl?: typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-llm-routes-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-llm-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const store = new TextModelConfigStore(dataDir);
  const textModel = model ?? createOpenCodeModel({ store, fetch: fetchImpl ?? fakeFetch(m => ok(m)).fetchImpl });
  server = Fastify();
  await registerProviderRoutes(server, { userAuthStore: auth, dataDir, flow: new FlowStore(join(dataDir, 'flow')), text: { store, model: textModel } });
  await server.ready();
  const as = (cookie: string) => (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    server!.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { dataDir, store, admin: as(`oc_session=${auth.createSession(admin.id).token}`), member: as(`oc_session=${auth.createSession(member.id).token}`) };
}

const fakeModel = (impl: TextModel['chat']): TextModel => ({ chat: impl, configured: async () => true });

describe('text model routes', () => {
  it('are admin-only', async () => {
    const t = await routes();
    expect((await server!.inject('/api/providers/text')).statusCode).toBe(401);
    expect((await t.member('GET', '/api/providers/text')).statusCode).toBe(403);
    expect((await t.member('PUT', '/api/providers/text', { apiKey: KEY })).statusCode).toBe(403);
    expect((await t.member('POST', '/api/providers/text/test')).statusCode).toBe(403);
    expect(await t.store.key()).toBeUndefined();
  });

  it('admin PUT stores the key; GET answers the keyHint (last 4) and never the key', async () => {
    const t = await routes();
    const put = await t.admin('PUT', '/api/providers/text', { apiKey: KEY, model: 'glm-5.3-flash' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ configured: true, keyHint: '••••wxyz', model: 'glm-5.3-flash' });
    expect(put.body).not.toContain(KEY);
    const get = await t.admin('GET', '/api/providers/text');
    expect(get.json()).toEqual({ configured: true, keyHint: '••••wxyz', model: 'glm-5.3-flash' });
    expect(get.body).not.toContain(KEY);
    expect(await t.store.key()).toBe(KEY);
  });

  it('PUT rejects bad input with 400', async () => {
    const t = await routes();
    expect((await t.admin('PUT', '/api/providers/text', { model: 'gpt-9' })).statusCode).toBe(400);
    expect((await t.admin('PUT', '/api/providers/text', { apiKey: 42 })).statusCode).toBe(400);
    expect((await t.admin('PUT', '/api/providers/text', { apiKey: 'short' })).statusCode).toBe(400);
  });

  it('test answers ok with the model that replied and the time taken', async () => {
    const t = await routes(fakeModel(async () => ({ message: { role: 'assistant', content: 'ok' }, model: 'glm-5.3-flash' })));
    const res = await t.admin('POST', '/api/providers/text/test');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, model: 'glm-5.3-flash', ms: expect.any(Number) });
  });

  it('test answers 502 with the plain message when the model fails, 400 when no key', async () => {
    const failing = await routes(fakeModel(async () => { throw new LlmError('UNAVAILABLE', 'Model teks sedang tidak tersedia.'); }));
    const res = await failing.admin('POST', '/api/providers/text/test');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: 'UNAVAILABLE', message: 'Model teks sedang tidak tersedia.' } });
    await server!.close();
    const unset = await routes(fakeModel(async () => { throw new LlmError('NOT_CONFIGURED', 'API key OpenCode Go belum diisi.'); }));
    const none = await unset.admin('POST', '/api/providers/text/test');
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('NOT_CONFIGURED');
  });
  it('test tries only the chosen model with a 20 s limit, so the button never waits on the whole chain', async () => {
    let seen: Parameters<TextModel['chat']>[0] | undefined;
    const t = await routes(fakeModel(async input => { seen = input; return { message: { role: 'assistant', content: 'ok' }, model: 'glm-5.3' }; }));
    expect((await t.admin('POST', '/api/providers/text/test')).statusCode).toBe(200);
    expect(seen).toMatchObject({ fallback: false, timeoutMs: 20_000 });
  });

  it('test calls fetch once on a 429 and answers 502', async () => {
    const f = fakeFetch(() => status(429));
    const t = await routes(undefined, f.fetchImpl);
    await t.store.patch({ apiKey: KEY });
    const res = await t.admin('POST', '/api/providers/text/test');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UNAVAILABLE');
    expect(f.calls).toHaveLength(1);
  });
});

describe('buildApp wiring', () => {
  it('the routes and the model share one store: a key saved over PUT is used by the test call', async () => {
    const f = fakeFetch(model => ok(model));
    const app = await buildApp({
      dataDir: mkdtempSync(join(tmpdir(), 'nc-llm-app-')),
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0 },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 },
      text: { fetch: f.fetchImpl }
    });
    server = app;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ method: 'PUT', url: '/api/providers/text', headers: { cookie }, payload: { apiKey: KEY } })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/api/providers/text/test', headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true, model: 'glm-5.3-flash' });
    expect(f.calls.map(c => [c.url, c.headers.get('authorization')])).toEqual([[URL_CHAT, `Bearer ${KEY}`]]);
  });
});

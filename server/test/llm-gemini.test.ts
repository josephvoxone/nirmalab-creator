import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderKeys } from '../src/lib/provider-keys.js';
import { DEFAULT_GEMINI_MODEL, createGeminiModel, probeGeminiKey } from '../src/llm/gemini.js';
import { LlmError } from '../src/llm/opencode.js';

let dir: string; let seq = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const K1 = 'AIzaSyKEY_one_0123456789abcdefghijk';
const K2 = 'AIzaSyKEY_two_0123456789abcdefghijk';
type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const reply = (content: string) => json(200, { choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 12 } });
const bearer = (c: Call) => (c.init.headers as Record<string, string>).authorization;

async function setup(handler: (c: Call, n: number) => Response | Promise<Response>, keys = [K1, K2], model?: () => Promise<string | undefined>) {
  const pool = new ProviderKeys(join(dir, `p${seq++}`), 'gemini', { env: {} });
  await pool.load();
  for (const k of keys) await pool.add({ key: k });
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { const c = { url: String(url), init: init ?? {} }; calls.push(c); return handler(c, calls.length); }) as unknown as typeof fetch;
  return { model: createGeminiModel({ keys: pool, fetch: fetchImpl, ...(model ? { chosenModel: model } : {}) }), pool, calls };
}

describe('Gemini text model', () => {
  it('posts an OpenAI-style chat completion with the bearer key, the model, tools and max_tokens', async () => {
    const { model, calls } = await setup(() => reply('Halo.'));
    const tools = [{ type: 'function' as const, function: { name: 'x', description: 'd', parameters: { type: 'object' } } }];
    const out = await model.chat({ messages: [{ role: 'user', content: 'hai' }], tools, maxTokens: 500 });
    expect(out.message.content).toBe('Halo.');
    expect(out.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(bearer(calls[0]!)).toBe(`Bearer ${K1}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: DEFAULT_GEMINI_MODEL, messages: [{ role: 'user', content: 'hai' }], tools, max_tokens: 500 });
  });

  it('uses the model chosen in the settings', async () => {
    const { model, calls } = await setup(() => reply('ok'), [K1], async () => 'gemini-3.6-flash');
    await model.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('gemini-3.6-flash');
  });

  it('returns tool calls the way the other text models do', async () => {
    const { model } = await setup(() => json(200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_zoom', arguments: '{"shot":10}' } }] } }] }));
    const out = await model.chat({ messages: [{ role: 'user', content: 'zoom' }] });
    expect(out.message.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'set_zoom', arguments: '{"shot":10}' } }]);
  });

  it('round-robin: consecutive calls use the keys in turn', async () => {
    const { model, calls } = await setup(() => reply('ok'));
    for (let i = 0; i < 4; i++) await model.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls.map(bearer)).toEqual([`Bearer ${K1}`, `Bearer ${K2}`, `Bearer ${K1}`, `Bearer ${K2}`]);
  });

  it('a 429 on one key moves the same call to the next key, and the cooled key is left alone afterwards', async () => {
    const { model, calls, pool } = await setup(c => (bearer(c) === `Bearer ${K1}` ? json(429, { error: { message: 'quota' } }, { 'retry-after': '30' }) : reply('ok')));
    expect((await model.chat({ messages: [{ role: 'user', content: 'x' }] })).message.content).toBe('ok');
    expect(calls.map(bearer)).toEqual([`Bearer ${K1}`, `Bearer ${K2}`]);
    calls.length = 0;
    await model.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls.map(bearer)).toEqual([`Bearer ${K2}`]);
    // a 429 is a per-model quota: the key stays usable for other models and is limited for this one only
    expect(pool.view()[0]).toMatchObject({ state: 'ready', limited: [DEFAULT_GEMINI_MODEL] });
  });

  it('a refused key (400 API key not valid / 401 / 403) is marked invalid and skipped', async () => {
    const { model, pool } = await setup(c => (bearer(c) === `Bearer ${K1}` ? json(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }) : reply('ok')));
    await model.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(pool.view()[0]).toMatchObject({ state: 'invalid' });
  });

  it('when every key is rate limited for the first model it tries the next model before giving up', async () => {
    const seen: string[] = [];
    const { model } = await setup(c => {
      const m = JSON.parse(String(c.init.body)).model as string;
      seen.push(m);
      return m === 'gemini-big' ? json(429, {}, { 'retry-after': '120' }) : reply('from fallback');
    }, [K1, K2], async () => 'gemini-big');
    const out = await model.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(out.message.content).toBe('from fallback');
    expect(seen[0]).toBe('gemini-big');
    expect(seen.at(-1)).not.toBe('gemini-big');
  });

  it('fallback:false (the settings Tes button) tries the chosen model only', async () => {
    const { model, calls } = await setup(() => json(429, {}, { 'retry-after': '60' }));
    await expect(model.chat({ messages: [{ role: 'user', content: 'x' }], fallback: false })).rejects.toBeInstanceOf(LlmError);
    expect(new Set(calls.map(c => JSON.parse(String(c.init.body)).model)).size).toBe(1);
  });

  it('no keys: NOT_CONFIGURED pointing at the settings; configured() is false', async () => {
    const { model } = await setup(() => reply('x'), []);
    expect(await model.configured()).toBe(false);
    await expect(model.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('a request Gemini calls wrong (another 400) is not retried on other keys and says why', async () => {
    const { model, calls } = await setup(() => json(400, { error: { message: 'Unable to submit request because the model does not support tools', status: 'INVALID_ARGUMENT' } }));
    const err = await model.chat({ messages: [{ role: 'user', content: 'x' }] }).catch(e => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(1);
  });

  it('a caller abort stops at once and does not blame a key', async () => {
    const { model, pool } = await setup(() => reply('x'));
    const ctl = new AbortController(); ctl.abort();
    await expect(model.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctl.signal })).rejects.toBeInstanceOf(LlmError);
    expect(pool.view().every(v => v.failures === 0)).toBe(true);
  });

  it('a hung call is cut after the timeout and the next key is tried', async () => {
    vi.useFakeTimers();
    const { model, calls } = await setup(c => (bearer(c) === `Bearer ${K1}` ? new Promise<Response>((_, rej) => (c.init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')))) : reply('ok')));
    const p = model.chat({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_500);
    expect((await p).message.content).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('a key never appears in an error', async () => {
    const { model } = await setup(() => json(400, { error: { message: `bad request for key ${K1}` } }));
    const err = await model.chat({ messages: [{ role: 'user', content: 'x' }] }).catch(e => e);
    expect(String(err.message)).not.toContain('AIzaSyKEY');
  });
});

describe('probeGeminiKey', () => {
  it('lists models with the key (free) to prove it works', async () => {
    const f = (async (url: string, init: RequestInit) => { expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models'); expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${K1}`); return json(200, { data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/text-embedding-004' }] }); }) as unknown as typeof fetch;
    expect(await probeGeminiKey(f, K1)).toMatchObject({ ok: true, models: ['gemini-3.8-flash', 'text-embedding-004'] });
  });
  it('a refused key is reported as rejected; an unreachable service as not rejected', async () => {
    expect(await probeGeminiKey((async () => json(400, { error: { message: 'API key not valid' } })) as unknown as typeof fetch, K1)).toMatchObject({ ok: false, rejected: true });
    expect(await probeGeminiKey((async () => { throw new Error('net'); }) as unknown as typeof fetch, K1)).toMatchObject({ ok: false, rejected: false });
  });
});

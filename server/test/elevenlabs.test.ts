import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderKeys } from '../src/lib/provider-keys.js';
import { DubError, ElevenLabsClient, estimateCredits } from '../src/dub/elevenlabs.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eleven-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const KEY1 = 'sk_eleven_key_one_0123456789abcdef0123';
const KEY2 = 'sk_eleven_key_two_0123456789abcdef0123';
const AUDIO = Buffer.from('ID3-fake-mp3-bytes-'.repeat(200));

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const audio = () => new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

let seq = 0;
async function client(handler: Parameters<typeof fakeFetch>[0], keys = [KEY1, KEY2]) {
  const pool = new ProviderKeys(join(dir, `p${seq++}`), 'elevenlabs', { env: {} });
  await pool.load();
  for (const key of keys) await pool.add({ key });
  const f = fakeFetch(handler);
  return { c: new ElevenLabsClient({ keys: pool, fetch: f.fn }), pool, calls: f.calls };
}

describe('ElevenLabsClient.synthesize', () => {
  it('posts the text to the voice with the key, model and voice settings and returns the mp3 bytes', async () => {
    const { c, calls } = await client(() => audio());
    const out = await c.synthesize({ text: 'Aku menyentuhnya.', voiceId: 'VOICE123', modelId: 'eleven_multilingual_v2', settings: { stability: 0.6, similarityBoost: 0.8, style: 0.2, speed: 0.95, speakerBoost: true }, seed: 7 });
    expect(out.audio.equals(AUDIO)).toBe(true);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/VOICE123?output_format=mp3_44100_128');
    expect(call.init.method).toBe('POST');
    expect(header(call, 'xi-api-key')).toBe(KEY1);
    expect(JSON.parse(String(call.init.body))).toEqual({
      text: 'Aku menyentuhnya.', model_id: 'eleven_multilingual_v2', seed: 7,
      voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.2, speed: 0.95, use_speaker_boost: true }
    });
  });

  it('sends language_code only for models that accept it (Flash/Turbo v2.5); multilingual_v2 would be rejected', async () => {
    const { c, calls } = await client(() => audio());
    await c.synthesize({ text: 'Halo.', voiceId: 'V', modelId: 'eleven_flash_v2_5', languageCode: 'id' });
    await c.synthesize({ text: 'Halo.', voiceId: 'V', modelId: 'eleven_multilingual_v2', languageCode: 'id' });
    expect(JSON.parse(String(calls[0]!.init.body)).language_code).toBe('id');
    expect(JSON.parse(String(calls[1]!.init.body)).language_code).toBeUndefined();
  });

  it('passes previous/next text so neighbouring lines keep one intonation', async () => {
    const { c, calls } = await client(() => audio());
    await c.synthesize({ text: 'B.', voiceId: 'V', modelId: 'eleven_multilingual_v2', previousText: 'A.', nextText: 'C.' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ previous_text: 'A.', next_text: 'C.' });
  });

  it('clamps voice settings to what the API accepts', async () => {
    const { c, calls } = await client(() => audio());
    await c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2', settings: { stability: 5, similarityBoost: -1, speed: 3 } });
    expect(JSON.parse(String(calls[0]!.init.body)).voice_settings).toMatchObject({ stability: 1, similarity_boost: 0, speed: 1.2 });
  });

  it('a rate-limited key (429) is skipped: the same request moves to the next key', async () => {
    const { c, calls, pool } = await client(({ init }) => ((init.headers as Record<string, string>)['xi-api-key'] === KEY1 ? json(429, { detail: { status: 'too_many_concurrent_requests', message: 'slow down' } }) : audio()));
    const out = await c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' });
    expect(out.audio.length).toBeGreaterThan(0);
    expect(calls.map(c2 => header(c2, 'xi-api-key'))).toEqual([KEY1, KEY2]);
    expect(pool.view().find(v => v.source === 'store' && v.state === 'cooldown')).toBeTruthy();
  });

  it('a refused key (401) is marked invalid; out-of-credits (quota_exceeded) is a long cooldown, not "invalid"', async () => {
    const { c, pool } = await client(({ init }) => {
      const k = (init.headers as Record<string, string>)['xi-api-key'];
      if (k === KEY1) return json(401, { detail: { status: 'invalid_api_key', message: 'bad' } });
      return audio();
    });
    await c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' });
    expect(pool.view()[0]).toMatchObject({ state: 'invalid' });

    const q = await client(({ init }) => ((init.headers as Record<string, string>)['xi-api-key'] === KEY1 ? json(401, { detail: { status: 'quota_exceeded', message: 'You have 0 credits' } }) : audio()));
    await q.c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' });
    const v = q.pool.view()[0]!;
    expect(v.state).toBe('cooldown');
    expect(v.reason).toMatch(/kuota|kredit/i);
    expect(v.cooldownUntilMs! - Date.now()).toBeGreaterThan(10 * 60_000);
  });

  it('a request the API refuses as wrong (400/422) fails at once with the reason; no other key is tried', async () => {
    const { c, calls } = await client(() => json(422, { detail: [{ msg: 'text too long', loc: ['body', 'text'] }] }));
    await expect(c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' })).rejects.toMatchObject({ code: 'REJECTED' });
    expect(calls).toHaveLength(1);
  });

  it('when every key fails with a server error it reports UNAVAILABLE', async () => {
    const { c, calls } = await client(() => json(503, {}));
    await expect(c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toHaveLength(2);
  });

  it('no keys at all: NOT_CONFIGURED with a pointer to the settings', async () => {
    const { c } = await client(() => audio(), []);
    const err = await c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' }).catch(e => e);
    expect(err).toBeInstanceOf(DubError);
    expect(err).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(String(err.message)).toMatch(/Pengaturan/);
  });

  it('an answer that is not audio (an error page with 200) is not saved as an mp3', async () => {
    const { c } = await client(() => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('never puts a key in an error message', async () => {
    // the provider's own text reaches the user on a 4xx refusal: it must not carry a key
    const { c } = await client(() => json(400, { detail: { status: 'invalid_request', message: `bad key ${KEY1} for this voice` } }));
    const err = await c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' }).catch(e => e);
    expect(String(err.message)).not.toContain('sk_eleven_key');
  });

  it('refuses empty text and text over the per-request limit before spending anything', async () => {
    const { c, calls } = await client(() => audio());
    await expect(c.synthesize({ text: '   ', voiceId: 'V', modelId: 'eleven_multilingual_v2' })).rejects.toMatchObject({ code: 'REJECTED' });
    await expect(c.synthesize({ text: 'x'.repeat(2501), voiceId: 'V', modelId: 'eleven_multilingual_v2' })).rejects.toMatchObject({ code: 'REJECTED' });
    expect(calls).toHaveLength(0);
  });

  it('a call that takes too long is cut and the next key is tried', async () => {
    vi.useFakeTimers();
    const { c, calls } = await client(({ init }) => (
      (init.headers as Record<string, string>)['xi-api-key'] === KEY1
        ? new Promise<Response>((_, reject) => { (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted'))); })
        : audio()
    ));
    const p = c.synthesize({ text: 'x', voiceId: 'V', modelId: 'eleven_multilingual_v2' });
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await p).audio.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  });
});

describe('ElevenLabsClient.voices / subscription', () => {
  it('lists voices (all pages) and caches them', async () => {
    const { c, calls } = await client(({ url }) => (url.includes('page_token=p2')
      ? json(200, { voices: [{ voice_id: 'b', name: 'Bima', category: 'premade', labels: { gender: 'male' } }], has_more: false })
      : json(200, { voices: [{ voice_id: 'a', name: 'Arya', category: 'premade', preview_url: 'https://x/p.mp3', labels: { gender: 'male', age: 'old' } }], has_more: true, next_page_token: 'p2' })));
    const first = await c.voices();
    expect(first.map(v => v.id)).toEqual(['a', 'b']);
    expect(first[0]).toMatchObject({ name: 'Arya', gender: 'male', age: 'old', previewUrl: 'https://x/p.mp3' });
    expect(calls[0]!.url).toContain('/v2/voices?page_size=100');
    await c.voices();
    expect(calls).toHaveLength(2); // second listing served from the cache
  });

  it('reports the credits left of one key without spending any', async () => {
    const { c, pool, calls } = await client(() => json(200, { tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1893456000 }));
    const info = await c.subscription(pool.view()[0]!.id);
    expect(info).toMatchObject({ tier: 'creator', used: 1200, limit: 100000, left: 98800 });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/user/subscription');
  });

  it('a wrong key in the test reports ok:false with a readable reason', async () => {
    const { c, pool } = await client(() => json(401, { detail: { status: 'invalid_api_key' } }));
    expect(await c.subscription(pool.view()[0]!.id)).toMatchObject({ ok: false });
  });
});

describe('estimateCredits', () => {
  it('counts characters x the model rate (Flash is half price)', () => {
    expect(estimateCredits(['Halo dunia', 'Dua'], 'eleven_multilingual_v2')).toBe(13);
    expect(estimateCredits(['Halo dunia', 'Dua'], 'eleven_flash_v2_5')).toBe(6.5);
    expect(estimateCredits([], 'eleven_flash_v2_5')).toBe(0);
  });
});

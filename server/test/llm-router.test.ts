import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FairQueue } from '../src/lib/fair-queue.js';
import { TextRoutingStore, createRoutedModel, limitedModel } from '../src/llm/router.js';
import { LlmError, type ChatInput, type TextModel } from '../src/llm/opencode.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'route-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const msg = (text: string) => ({ message: { role: 'assistant' as const, content: text }, model: text });
const input: ChatInput = { messages: [{ role: 'user', content: 'x' }] };
function fake(name: string, behaviour: 'ok' | 'unavailable' | 'bad' | 'off', log: string[]): TextModel {
  return {
    configured: async () => behaviour !== 'off',
    chat: async () => {
      log.push(name);
      if (behaviour === 'off') throw new LlmError('NOT_CONFIGURED', `${name} belum diisi`);
      if (behaviour === 'unavailable') throw new LlmError('UNAVAILABLE', `${name} sibuk`);
      if (behaviour === 'bad') throw new LlmError('BAD_RESPONSE', `${name} jawaban rusak`);
      return msg(name);
    }
  };
}
const routed = (a: TextModel, b: TextModel, primary: 'opencode-go' | 'gemini' = 'opencode-go') => createRoutedModel({ opencode: a, gemini: b, routing: async () => ({ primary }) });

describe('TextRoutingStore', () => {
  it('defaults to OpenCode Go, stores the choice privately and validates it', async () => {
    const store = new TextRoutingStore(dir);
    expect(await store.view()).toEqual({ primary: 'opencode-go' });
    expect(await store.patch({ primary: 'gemini', geminiModel: 'gemini-3.6-flash' })).toEqual({ primary: 'gemini', geminiModel: 'gemini-3.6-flash' });
    expect(await new TextRoutingStore(dir).view()).toMatchObject({ primary: 'gemini' });
    await expect(store.patch({ primary: 'gpt' as never })).rejects.toThrow(/primary/);
    await expect(store.patch({ geminiModel: 'not a model' })).rejects.toThrow(/model/i);
    expect(await store.patch({ geminiModel: null })).toEqual({ primary: 'gemini' });
  });
});

describe('createRoutedModel', () => {
  it('uses the primary; the other one is only a fallback', async () => {
    const log: string[] = [];
    const out = await routed(fake('opencode', 'ok', log), fake('gemini', 'ok', log)).chat(input);
    expect(out.message.content).toBe('opencode');
    expect(log).toEqual(['opencode']);
    log.length = 0;
    expect((await routed(fake('opencode', 'ok', log), fake('gemini', 'ok', log), 'gemini').chat(input)).message.content).toBe('gemini');
  });

  it('falls back to the other provider when the primary is unavailable or answers garbage', async () => {
    for (const bad of ['unavailable', 'bad'] as const) {
      const log: string[] = [];
      const out = await routed(fake('opencode', bad, log), fake('gemini', 'ok', log)).chat(input);
      expect(out.message.content).toBe('gemini');
      expect(log).toEqual(['opencode', 'gemini']);
    }
  });

  it('skips a provider that has no key; with only Gemini configured Gemini serves everything', async () => {
    const log: string[] = [];
    const m = routed(fake('opencode', 'off', log), fake('gemini', 'ok', log));
    expect((await m.chat(input)).message.content).toBe('gemini');
    expect(log).toEqual(['gemini']);
    expect(await m.configured()).toBe(true);
  });

  it('neither configured: one clear NOT_CONFIGURED', async () => {
    const m = routed(fake('opencode', 'off', []), fake('gemini', 'off', []));
    expect(await m.configured()).toBe(false);
    await expect(m.chat(input)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('both failing: the primary\'s reason is what the user reads, after trying both', async () => {
    const log: string[] = [];
    await expect(routed(fake('opencode', 'unavailable', log), fake('gemini', 'unavailable', log)).chat(input)).rejects.toThrow(/opencode sibuk/);
    expect(log).toEqual(['opencode', 'gemini']);
  });

  it('fallback:false (the settings Tes button) tries the primary only', async () => {
    const log: string[] = [];
    await expect(routed(fake('opencode', 'unavailable', log), fake('gemini', 'ok', log)).chat({ ...input, fallback: false })).rejects.toBeInstanceOf(LlmError);
    expect(log).toEqual(['opencode']);
  });

  it('a caller abort is not retried on the other provider', async () => {
    const ctl = new AbortController();
    const log: string[] = [];
    const a: TextModel = { configured: async () => true, chat: async () => { log.push('a'); ctl.abort(); throw new LlmError('UNAVAILABLE', 'Permintaan ke model teks dibatalkan.'); } };
    await expect(routed(a, fake('gemini', 'ok', log)).chat({ ...input, signal: ctl.signal })).rejects.toBeInstanceOf(LlmError);
    expect(log).toEqual(['a']);
  });
});

describe('limitedModel', () => {
  it('never has more model calls in flight than the limit', async () => {
    let running = 0; let peak = 0;
    const slow: TextModel = { configured: async () => true, chat: async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 5)); running--; return msg('ok'); } };
    const m = limitedModel(slow, new FairQueue({ concurrency: 3 }));
    await Promise.all(Array.from({ length: 12 }, () => m.chat(input)));
    expect(peak).toBe(3);
  });

  it('a full queue says "ramai" as an LlmError instead of piling up', async () => {
    const hold: TextModel = { configured: async () => true, chat: () => new Promise(() => undefined) };
    const m = limitedModel(hold, new FairQueue({ concurrency: 1, maxWaiting: 1 }));
    void m.chat(input); void m.chat(input);
    await new Promise(r => setImmediate(r));
    await expect(m.chat(input)).rejects.toMatchObject({ name: 'LlmError', code: 'UNAVAILABLE' });
  });

  it('configured() passes straight through', async () => {
    const m = limitedModel(fake('x', 'off', []), new FairQueue({ concurrency: 1 }));
    expect(await m.configured()).toBe(false);
  });
});

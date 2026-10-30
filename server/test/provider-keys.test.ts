import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderKeys, MAX_POOL_KEYS } from '../src/lib/provider-keys.js';
import { ProviderInputError } from '../src/providers/config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pkeys-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const secret = (n: number) => `sk_test_${String(n).padStart(2, '0')}_0123456789abcdef0123456789`;

describe('ProviderKeys', () => {
  it('adds keys, persists them privately and feeds the pool', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs');
    await keys.load();
    const added = await keys.add({ key: secret(1), label: 'Utama' });
    expect(added).toMatchObject({ label: 'Utama', keyHint: '••••6789'.replace('6789', secret(1).slice(-4)), source: 'store' });
    expect(JSON.stringify(added)).not.toContain(secret(1));
    expect(keys.pool.size()).toBe(1);
    const file = join(dir, 'providers', 'keypool-elevenlabs.json');
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    // a new process sees the same keys
    const again = new ProviderKeys(dir, 'elevenlabs');
    await again.load();
    expect(again.view().map(v => v.label)).toEqual(['Utama']);
    expect(again.pool.size()).toBe(1);
  });

  it('keeps each provider in its own file', async () => {
    const a = new ProviderKeys(dir, 'elevenlabs'); const b = new ProviderKeys(dir, 'gemini');
    await a.load(); await b.load();
    await a.add({ key: secret(1) }); await b.add({ key: secret(2) });
    expect(a.view()).toHaveLength(1);
    expect(b.view()).toHaveLength(1);
    expect(readFileSync(join(dir, 'providers', 'keypool-gemini.json'), 'utf8')).not.toContain(secret(1));
  });

  it('refuses an 11th key (max 10), a duplicate, and malformed keys', async () => {
    const keys = new ProviderKeys(dir, 'gemini');
    await keys.load();
    for (let i = 1; i <= MAX_POOL_KEYS; i++) await keys.add({ key: secret(i) });
    await expect(keys.add({ key: secret(99) })).rejects.toThrow(/maksimal 10/i);
    await keys.remove(keys.view()[0]!.id);
    await expect(keys.add({ key: secret(2) })).rejects.toThrow(/sudah ada/i);
    await expect(keys.add({ key: 'short' })).rejects.toBeInstanceOf(ProviderInputError);
    await expect(keys.add({ key: 'has a space in it 1234567890' })).rejects.toBeInstanceOf(ProviderInputError);
    await expect(keys.add({ key: secret(50), label: 'x'.repeat(41) })).rejects.toBeInstanceOf(ProviderInputError);
    expect(keys.pool.size()).toBe(MAX_POOL_KEYS - 1);
  });

  it('removes a key from the file and the pool', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs');
    await keys.load();
    const one = await keys.add({ key: secret(1) });
    await keys.add({ key: secret(2) });
    expect(await keys.remove(one.id)).toBe(true);
    expect(await keys.remove(one.id)).toBe(false);
    expect(keys.pool.size()).toBe(1);
    const again = new ProviderKeys(dir, 'elevenlabs');
    await again.load();
    expect(again.view()).toHaveLength(1);
  });

  it('merges keys from the server environment (comma separated), read-only, counted in the max', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: { ELEVENLABS_API_KEYS: ` ${secret(7)} , ${secret(8)} ,,` } });
    await keys.load();
    expect(keys.view().map(v => v.source)).toEqual(['env', 'env']);
    await keys.add({ key: secret(1) });
    expect(keys.pool.size()).toBe(3);
    const env = keys.view().find(v => v.source === 'env')!;
    expect(await keys.remove(env.id)).toBe(false); // env keys are managed outside the app
    for (let i = 20; i < 20 + MAX_POOL_KEYS - 3; i++) await keys.add({ key: secret(i) });
    await expect(keys.add({ key: secret(77) })).rejects.toThrow(/maksimal 10/i);
  });

  it('ids are stable for the same key and never reveal it', async () => {
    const a = new ProviderKeys(dir, 'gemini'); await a.load();
    const first = await a.add({ key: secret(5) });
    const b = new ProviderKeys(dir, 'gemini'); await b.load();
    expect(b.view()[0]!.id).toBe(first.id);
    expect(first.id).not.toContain(secret(5).slice(10, 20));
  });

  it('a corrupt file does not crash the server: it starts empty', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'providers'), { recursive: true });
    writeFileSync(join(dir, 'providers', 'keypool-gemini.json'), '{not json');
    const keys = new ProviderKeys(dir, 'gemini');
    await keys.load();
    expect(keys.view()).toEqual([]);
  });

  it('concurrent adds do not lose keys', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs');
    await keys.load();
    await Promise.all([1, 2, 3, 4, 5].map(n => keys.add({ key: secret(n) })));
    const again = new ProviderKeys(dir, 'elevenlabs');
    await again.load();
    expect(again.view()).toHaveLength(5);
  });
});

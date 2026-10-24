import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenRouterConfigStore } from '../src/providers/config.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdefWXYZ';

describe('OpenRouterConfigStore', () => {
  it('stores the key in providers/openrouter.json with mode 0600 and only exposes keyHint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-prov-'));
    const store = new OpenRouterConfigStore(dataDir);
    expect(await store.view()).toEqual({ configured: false, defaults: {} });

    const view = await store.update({ apiKey: KEY, defaults: { video: 'google/veo-3.1-fast' } });
    expect(view).toEqual({ configured: true, keyHint: '••••WXYZ', defaults: { video: 'google/veo-3.1-fast' } });
    expect(JSON.stringify(view)).not.toContain(KEY);

    const file = join(dataDir, 'providers', 'openrouter.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).apiKey).toBe(KEY);
    expect(await store.apiKey()).toBe(KEY);
  });

  it('keeps the key when only defaults change, clears a default with null, removes the key with null', async () => {
    const store = new OpenRouterConfigStore(mkdtempSync(join(tmpdir(), 'nc-prov-')));
    await store.update({ apiKey: KEY, defaults: { image: 'openai/gpt-image-1', video: 'google/veo-3.1' } });
    expect(await store.update({ defaults: { image: null } })).toEqual({ configured: true, keyHint: '••••WXYZ', defaults: { video: 'google/veo-3.1' } });
    expect(await store.update({ apiKey: null })).toEqual({ configured: false, defaults: { video: 'google/veo-3.1' } });
    expect(await store.apiKey()).toBeUndefined();
  });

  it('rejects a malformed key or model id', async () => {
    const store = new OpenRouterConfigStore(mkdtempSync(join(tmpdir(), 'nc-prov-')));
    await expect(store.update({ apiKey: 'short' })).rejects.toThrow(/API key/);
    await expect(store.update({ apiKey: 'has spaces in the key 1234567890' })).rejects.toThrow(/API key/);
    await expect(store.update({ defaults: { video: 'not a model' } })).rejects.toThrow(/model/);
  });
});

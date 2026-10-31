import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublisherTokenStore } from '../src/publisher/token-store.js';

const fresh = () => {
  const root = join(mkdtempSync(join(tmpdir(), 'nc-pts-')), 'publisher');
  return { root, store: new PublisherTokenStore(root) };
};

describe('PublisherTokenStore keyed by (userId, platform)', () => {
  it('keeps the same platform separate per user and the same user separate per platform', async () => {
    const { store } = fresh();
    await store.save('u_alpha', 'youtube', { accessToken: 'a-yt' });
    await store.save('u_beta', 'youtube', { accessToken: 'b-yt' });
    await store.save('u_alpha', 'tiktok', { accessToken: 'a-tt' });
    expect((await store.get('u_alpha', 'youtube'))?.accessToken).toBe('a-yt');
    expect((await store.get('u_beta', 'youtube'))?.accessToken).toBe('b-yt');
    expect((await store.get('u_alpha', 'tiktok'))?.accessToken).toBe('a-tt');
    expect(await store.get('u_beta', 'tiktok')).toBeUndefined();
    expect(await store.get('u_gamma', 'youtube')).toBeUndefined();
  });

  it('files are 0600 in a 0700 per-user directory', async () => {
    const { store, root } = fresh();
    await store.save('u_alpha', 'meta', { accessToken: 'x', extra: { pageId: '1', pageToken: 't' } });
    expect(statSync(join(root, 'u_alpha', 'meta.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'u_alpha')).mode & 0o777).toBe(0o700);
  });

  it('writes atomically: concurrent saves always leave one complete JSON file and no temp files', async () => {
    const { store, root } = fresh();
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.save('u_alpha', 'youtube', { accessToken: `t${i}`, accountLabel: 'x'.repeat(5000) })));
    const text = readFileSync(join(root, 'u_alpha', 'youtube.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ version: 1, platform: 'youtube' });
    expect(readdirSync(join(root, 'u_alpha'))).toEqual(['youtube.json']);
  });

  it('refuses a user id that could leave the publisher directory', async () => {
    const { store } = fresh();
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65), 'u 1']) {
      await expect(store.save(bad, 'youtube', { accessToken: 'x' })).rejects.toThrow(/user id/i);
      await expect(store.get(bad, 'youtube')).rejects.toThrow(/user id/i);
      await expect(store.revokeAllFor(bad)).rejects.toThrow(/user id/i);
    }
  });

  it('clear removes one platform of one user only', async () => {
    const { store } = fresh();
    await store.save('u_alpha', 'youtube', { accessToken: 'a' });
    await store.save('u_alpha', 'tiktok', { accessToken: 'b' });
    await store.save('u_beta', 'youtube', { accessToken: 'c' });
    await store.clear('u_alpha', 'youtube');
    expect(await store.get('u_alpha', 'youtube')).toBeUndefined();
    expect(await store.get('u_alpha', 'tiktok')).toBeDefined();
    expect(await store.get('u_beta', 'youtube')).toBeDefined();
  });

  it('there is no way to read a platform-wide token any more: a legacy <platform>.json at the root is ignored', async () => {
    const { store, root } = fresh();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'youtube.json'), JSON.stringify({ version: 1, platform: 'youtube', accessToken: 'legacy', updatedAt: 'x' }));
    expect(await store.get('u_alpha', 'youtube')).toBeUndefined();
    expect(await store.get('youtube', 'youtube')).toBeUndefined();
  });
});

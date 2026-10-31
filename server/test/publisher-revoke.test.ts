import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PublisherService } from '../src/publisher/service.js';
import { publisherEnv, publisherWorld } from './publisher-world.js';

describe('T7.5 — disconnect is per user; revokeAllFor(userId) removes a member\'s connections', () => {
  it('Putuskan (disconnect) removes only the caller\'s connection of that platform', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    await w.connectAs(w.cookies.bina, 'B1');
    expect((await w.disconnect(w.cookies.joseph)).json()).toEqual({ ok: true });
    expect((await w.yt(w.cookies.joseph)).connected).toBe(false);
    expect((await w.yt(w.cookies.bina)).connected).toBe(true);
    expect(existsSync(join(w.dataDir, 'publisher', w.users.joseph.id, 'youtube.json'))).toBe(false);
    expect(existsSync(join(w.dataDir, 'publisher', w.users.bina.id, 'youtube.json'))).toBe(true);
    // disconnecting something you never connected is a harmless no-op
    expect((await w.disconnect(w.cookies.joseph, 'tiktok')).statusCode).toBe(200);
  });

  it('revokeAllFor deletes every token of that user and nobody else\'s; their publish stops working', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    await w.connectAs(w.cookies.bina, 'B1');
    const out = await w.service.revokeAllFor(w.users.bina.id);
    expect(out).toEqual({ platforms: ['youtube'], pendingConnections: 0 });
    expect(existsSync(join(w.dataDir, 'publisher', w.users.bina.id))).toBe(false);
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
    expect((await w.publish(w.cookies.bina)).json().error.code).toBe('NOT_CONNECTED');
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ connected: true, accountLabel: 'Channel(at-A1)' });
    expect((await w.publish(w.cookies.joseph)).statusCode).toBe(200);
    expect(w.google.uploads.map(u => u.authorization)).toEqual(['Bearer at-A1']);
  });

  it('revokeAllFor also drops the member\'s half-finished connection, so a late callback cannot resurrect it', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.bina);
    const out = await w.service.revokeAllFor(w.users.bina.id);
    expect(out.pendingConnections).toBe(1);
    const late = await w.callback(w.cookies.bina, state, 'B-LATE');
    expect(new URL(String(late.headers.location)).searchParams.get('connected')).toBeNull();
    expect(readdirSync(join(w.dataDir, 'publisher')).filter(n => n.startsWith('u_'))).toEqual([]);
  });

  it('covers all three platforms, is idempotent, and works for a user who never connected anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-pubrev-'));
    const service = new PublisherService({ dataDir: dir, env: publisherEnv, fetchImpl: vi.fn() as never });
    const { PublisherTokenStore } = await import('../src/publisher/token-store.js');
    const store = new PublisherTokenStore(join(dir, 'publisher'));
    for (const p of ['youtube', 'tiktok', 'meta'] as const) await store.save('u_member', p, { accessToken: `t-${p}` });
    await store.save('u_keep', 'meta', { accessToken: 'keep' });
    expect(await service.revokeAllFor('u_member')).toEqual({ platforms: ['youtube', 'tiktok', 'meta'], pendingConnections: 0 });
    expect(await service.revokeAllFor('u_member')).toEqual({ platforms: [], pendingConnections: 0 });
    expect(await service.revokeAllFor('u_never')).toEqual({ platforms: [], pendingConnections: 0 });
    expect((await store.get('u_keep', 'meta'))?.accessToken).toBe('keep');
    expect(readdirSync(join(dir, 'publisher'))).toEqual(['u_keep']);
  });

  it('makes no network call (the provider-side revoke is a separate, later step) and refuses an unsafe id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-pubrev-'));
    const fetchImpl = vi.fn();
    const service = new PublisherService({ dataDir: dir, env: publisherEnv, fetchImpl: fetchImpl as never });
    await service.revokeAllFor('u_member');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.revokeAllFor('../publisher')).rejects.toThrow(/user id/i);
  });

  it('an OAuth exchange that was already in flight when the user was revoked does not write a token afterwards', async () => {
    const w = await publisherWorld();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Same fake Google, but the token endpoint waits until the member has been revoked.
    const dir = mkdtempSync(join(tmpdir(), 'nc-pubrev-'));
    const slow = async (input: string | URL, init?: RequestInit) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') await gate;
      return w.google.fetchImpl(input, init);
    };
    const service = new PublisherService({ dataDir: dir, env: publisherEnv, fetchImpl: slow as never });
    const { state } = service.connectUrl('u_member', 'youtube');
    const pending = service.handleCallback('youtube', { code: 'LATE', state }, 'u_member');
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.revokeAllFor('u_member');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(existsSync(join(dir, 'publisher', 'u_member'))).toBe(false);
  });
});

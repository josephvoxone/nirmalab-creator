import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publisherWorld } from './publisher-world.js';

describe('T7.1 — publish tokens belong to the user who connected them', () => {
  it('B does not see the connection A made (status lists only your own)', async () => {
    const w = await publisherWorld();
    const done = await w.connectAs(w.cookies.joseph, 'A1');
    expect(done.headers.location).toContain('connected=youtube');
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ connected: true, accountLabel: 'Channel(at-A1)' });
    const seenByBina = await w.yt(w.cookies.bina);
    expect(seenByBina.connected).toBe(false);
    expect(seenByBina.accountLabel).toBeUndefined();
    const seenByMira = await w.yt(w.cookies.mira);
    expect(seenByMira.connected).toBe(false);
  });

  it('B publishing without a connection of their own fails NOT_CONNECTED and never uploads with A\'s token', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    const res = await w.publish(w.cookies.bina);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_CONNECTED');
    expect(w.google.uploads).toEqual([]);
  });

  it('two users connect their own accounts; each publish uses the publishing user\'s own token', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    await w.connectAs(w.cookies.bina, 'B1');
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ connected: true, accountLabel: 'Channel(at-A1)' });
    expect(await w.yt(w.cookies.bina)).toMatchObject({ connected: true, accountLabel: 'Channel(at-B1)' });
    expect((await w.publish(w.cookies.joseph)).statusCode).toBe(200);
    expect((await w.publish(w.cookies.bina)).statusCode).toBe(200);
    expect(w.google.uploads.map(u => u.authorization)).toEqual(['Bearer at-A1', 'Bearer at-B1']);
  });

  it('B disconnecting does not touch A\'s connection', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    await w.connectAs(w.cookies.bina, 'B1');
    expect((await w.disconnect(w.cookies.bina)).statusCode).toBe(200);
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ connected: true, accountLabel: 'Channel(at-A1)' });
  });

  it('on disk: <publisher>/<userId>/<platform>.json, mode 0600 (dir 0700), no global <platform>.json, no temp files left', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    const root = join(w.dataDir, 'publisher');
    const file = join(root, w.users.joseph.id, 'youtube.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, platform: 'youtube', accessToken: 'at-A1' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, w.users.joseph.id)).mode & 0o777).toBe(0o700);
    expect(readdirSync(root)).not.toContain('youtube.json');
    expect(readdirSync(join(root, w.users.joseph.id)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a refreshed access token is written back to the owner\'s file only', async () => {
    const w = await publisherWorld();
    await w.connectAs(w.cookies.joseph, 'A1');
    await w.connectAs(w.cookies.bina, 'B1');
    // Expire joseph's access token on disk, as time would.
    const { writeFileSync } = await import('node:fs');
    const file = join(w.dataDir, 'publisher', w.users.joseph.id, 'youtube.json');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...rec, expiresAtMs: Date.now() - 1000 }));
    expect((await w.publish(w.cookies.joseph)).statusCode).toBe(200);
    expect(w.google.refreshes).toEqual(['rt-A1']);
    expect(JSON.parse(readFileSync(file, 'utf8')).accessToken).toBe('fresh-of-rt-A1');
    const bina = JSON.parse(readFileSync(join(w.dataDir, 'publisher', w.users.bina.id, 'youtube.json'), 'utf8'));
    expect(bina.accessToken).toBe('at-B1');
  });
});

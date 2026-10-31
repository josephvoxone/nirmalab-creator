import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { adminWorld, SECRET, storyId, writeStory } from './admin-world.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const folderBytes = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? folderBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);

describe('T8 /api/storage byOwner — bytes per owner, no titles', () => {
  it('adds byOwner (every live user, projects + bytes) and the orphan total next to the existing report', async () => {
    const w = await adminWorld(); server = w.server;
    const mira = await w.addUser('mira@x.io');
    const bina = await w.addUser('bina@x.io');
    const a = storyId(); writeStory(w.dataDir, { id: a, ownerId: mira.user.id, extraBytes: 3000 });
    const b = storyId(); writeStory(w.dataDir, { id: b, ownerId: w.admin.id, extraBytes: 700 });
    const c = storyId(); writeStory(w.dataDir, { id: c, ownerId: bina.user.id, extraBytes: 90, title: 'Yatim Kecil' });
    await w.req('DELETE', `/api/auth/members/${bina.user.id}`);
    const res = await w.req('GET', '/api/storage');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // the existing report is intact
    expect(body.byArea.stories).toBeGreaterThan(0);
    expect(typeof body.usedBytes).toBe('number');
    expect(body.byOwner.map((o: { userId: string }) => o.userId).sort()).toEqual([w.admin.id, mira.user.id].sort());
    for (const row of body.byOwner) expect(Object.keys(row).sort()).toEqual(['bytes', 'email', 'projects', 'userId']);
    expect(body.byOwner.find((o: { userId: string }) => o.userId === mira.user.id)).toMatchObject({ email: mira.user.email, projects: 1, bytes: folderBytes(join(w.dataDir, 'stories', a)) });
    expect(body.orphans).toEqual({ projects: 1, bytes: folderBytes(join(w.dataDir, 'stories', c)) });
    // no title of anyone, orphan included (the orphan's title is only on /api/admin/projects)
    for (const text of [SECRET.title, 'Yatim Kecil', SECRET.prompt, SECRET.narration]) expect(res.body).not.toContain(text);
  });

  it('is still admin-only (401 / 403) and the bytes follow a transfer', async () => {
    const w = await adminWorld(); server = w.server;
    const mira = await w.addUser('mira@x.io');
    const bina = await w.addUser('bina@x.io');
    const c = storyId(); writeStory(w.dataDir, { id: c, ownerId: bina.user.id, extraBytes: 1234 });
    await w.req('DELETE', `/api/auth/members/${bina.user.id}`);
    expect((await w.req('GET', '/api/storage', '')).statusCode).toBe(401);
    expect((await w.req('GET', '/api/storage', mira.cookie)).statusCode).toBe(403);
    await w.req('POST', `/api/admin/projects/${c}/transfer`, undefined, { toUserId: mira.user.id });
    const body = (await w.req('GET', '/api/storage')).json();
    expect(body.orphans).toEqual({ projects: 0, bytes: 0 });
    expect(body.byOwner.find((o: { userId: string }) => o.userId === mira.user.id)).toMatchObject({ projects: 1, bytes: folderBytes(join(w.dataDir, 'stories', c)) });
  });
});

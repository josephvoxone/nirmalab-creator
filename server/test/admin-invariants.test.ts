import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { adminWorld, storyId, writeStory } from './admin-world.js';

const servers: FastifyInstance[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });
const world = async () => { const w = await adminWorld(); servers.push(w.server); return w; };
const dirs = (dataDir: string) => readdirSync(join(dataDir, 'stories')).sort();
const snapshot = (dataDir: string) => Object.fromEntries(dirs(dataDir).map(id => [id, readdirSync(join(dataDir, 'stories', id)).sort().map(f => `${f}=${readFileSync(join(dataDir, 'stories', id, f)).toString('base64')}`).join('|')]));

describe('C.5 invariants: removing a member loses nothing', () => {
  it('after removal: every project dir and byte is unchanged, the old owner is on record, the orphan can be moved to a living user who then sees it', async () => {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    const ids = [storyId(), storyId(), storyId()];
    writeStory(w.dataDir, { id: ids[0]!, ownerId: mira.user.id, title: 'Kakek Hilang Perahu', extraBytes: 777 });
    writeStory(w.dataDir, { id: ids[1]!, ownerId: mira.user.id });
    writeStory(w.dataDir, { id: ids[2]!, ownerId: w.admin.id, title: 'Punya Admin' });
    const before = snapshot(w.dataDir);
    const adminListBefore = (await w.req('GET', '/api/stories')).json().stories.map((s: { id: string }) => s.id).sort();
    expect((await w.req('DELETE', `/api/auth/members/${mira.user.id}`)).json().orphanedProjects).toBe(2);
    expect(dirs(w.dataDir)).toEqual(Object.keys(before).sort());
    expect(snapshot(w.dataDir)).toEqual(before);
    // the admin's own project list is unaffected by the removal
    expect((await w.req('GET', '/api/stories')).json().stories.map((s: { id: string }) => s.id).filter((id: string) => id === ids[2])).toEqual([ids[2]]);
    expect(adminListBefore).toContain(ids[2]);
    // previous owner recorded, twice over: tombstone (auth.json) and the orphan row
    const list = (await w.req('GET', '/api/admin/projects')).json();
    expect(list.orphans.map((o: { id: string }) => o.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(list.orphans.find((o: { id: string }) => o.id === ids[0])).toMatchObject({ title: 'Kakek Hilang Perahu', ownerId: mira.user.id, ownerEmail: mira.user.email });
    // movable, and the new owner has it
    const other = await w.addUser('bina@x.io', true);
    expect((await w.req('POST', `/api/admin/projects/${ids[0]}/transfer`, undefined, { toUserId: other.user.id })).statusCode).toBe(200);
    const mine = (await w.req('GET', '/api/stories', other.cookie)).json().stories.map((s: { id: string }) => s.id);
    expect(mine).toContain(ids[0]);
    const moved = JSON.parse(readFileSync(join(w.dataDir, 'stories', ids[0]!, 'story.json'), 'utf8'));
    expect(moved).toMatchObject({ createdBy: other.user.id, transferredFrom: mira.user.id, transferredBy: w.admin.id });
    expect(dirs(w.dataDir)).toEqual(Object.keys(before).sort());
  });

  it('a new account with the SAME email does not inherit the orphans (different id); the orphan stays an orphan with the old email', async () => {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    const id = storyId(); writeStory(w.dataDir, { id, ownerId: mira.user.id });
    await w.req('DELETE', `/api/auth/members/${mira.user.id}`);
    const again = await w.auth.createUser({ email: mira.user.email, password: 'member-pass-2', isAdmin: false });
    expect(again.id).not.toBe(mira.user.id);
    const list = (await w.req('GET', '/api/admin/projects')).json();
    expect(list.orphans.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(list.owners.find((o: { userId: string }) => o.userId === again.id).projects).toBe(0);
  });

  it('survives a restart of the server: the tombstone and the orphan list are read from disk', async () => {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    const id = storyId(); writeStory(w.dataDir, { id, ownerId: mira.user.id, title: 'Kakek Hilang Perahu' });
    await w.req('DELETE', `/api/auth/members/${mira.user.id}`);
    await w.server.close(); servers.length = 0;
    const second = await buildApp({ dataDir: w.dataDir, env: { OPENCREATOR_ADMIN_EMAIL: w.adminEmail, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' }, logger: false, stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 } });
    servers.push(second);
    const cookie = String((await second.inject({ method: 'POST', url: '/api/auth/login', payload: { email: w.adminEmail, password: 'admin-pass-1' } })).headers['set-cookie']).split(';')[0]!;
    const orphans = (await second.inject({ url: '/api/admin/projects', headers: { cookie } })).json().orphans;
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ id, title: 'Kakek Hilang Perahu', ownerEmail: mira.user.email });
  });

  it('two removals of the same member at the same time: both answer 200, one tombstone, one audit line, revocations done', async () => {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    writeStory(w.dataDir, { id: storyId(), ownerId: mira.user.id });
    const [a, b] = await Promise.all([w.req('DELETE', `/api/auth/members/${mira.user.id}`), w.req('DELETE', `/api/auth/members/${mira.user.id}`)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().alreadyRemoved, b.json().alreadyRemoved].filter(Boolean)).toHaveLength(1);
    expect(w.auth.tombstones()).toHaveLength(1);
    const entries = (await w.req('GET', '/api/admin/audit-log')).json().entries.filter((e: { action: string }) => e.action === 'anggota.hapus');
    expect(entries).toHaveLength(1);
  });

  it('production shape: admin + one member, one orphan "Kakek Hilang Perahu", six admin projects — nothing of the admin is orphaned or hidden', async () => {
    const w = await world();
    const member = await w.addUser('elfree899@gmail.com');
    const six = Array.from({ length: 6 }, () => storyId());
    six.forEach((id, i) => writeStory(w.dataDir, { id, ownerId: w.admin.id, title: `Lentera ${i}` }));
    const orphan = storyId(); writeStory(w.dataDir, { id: orphan, ownerId: 'u_removed_long_ago', title: 'Kakek Hilang Perahu' });
    const list = (await w.req('GET', '/api/admin/projects')).json();
    expect(list.owners.find((o: { userId: string }) => o.userId === w.admin.id).projects).toBe(6);
    expect(list.owners.find((o: { userId: string }) => o.userId === member.user.id).projects).toBe(0);
    expect(list.orphans).toHaveLength(1);
    expect(list.orphans[0]).toMatchObject({ id: orphan, title: 'Kakek Hilang Perahu', ownerId: 'u_removed_long_ago', ownerEmail: null });
    expect(six.every(id => existsSync(join(w.dataDir, 'stories', id)))).toBe(true);
  });
});

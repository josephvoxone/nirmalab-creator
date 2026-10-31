import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserAuthStore } from '../src/auth/store.js';
import { McpTokenStore } from '../src/mcp/tokens.js';
import { PublisherTokenStore } from '../src/publisher/token-store.js';
import { adminWorld, storyId, writeStory } from './admin-world.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const world = async () => { const w = await adminWorld(); server = w.server; return w; };
const dirBytes = (dir: string): string => readdirSync(dir).sort().map(n => `${n}:${readFileSync(join(dir, n)).toString('base64')}`).join('|');

describe('T8 suspend: refused with a clear message, the project stays', () => {
  it('sign-in of a suspended member is 403 ACCOUNT_SUSPENDED in plain Indonesian (only after the right password); a wrong password stays 401', async () => {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    const sid = storyId(); writeStory(w.dataDir, { id: sid, ownerId: mira.user.id });
    const before = dirBytes(join(w.dataDir, 'stories', sid));
    w.auth.setSuspended(mira.user.id, true, w.admin.id);
    expect((await w.req('GET', '/api/auth/me', mira.cookie)).statusCode).toBe(401);
    const ok = await w.login('mira@x.io', 'member-pass-1');
    expect(ok.res.statusCode).toBe(403);
    expect(ok.res.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(ok.res.json().error.message).toMatch(/ditangguhkan/i);
    expect(ok.res.headers['set-cookie']).toBeUndefined();
    expect((await w.login('mira@x.io', 'wrong-password')).res.statusCode).toBe(401);
    expect(dirBytes(join(w.dataDir, 'stories', sid))).toBe(before);
    w.auth.setSuspended(mira.user.id, false, w.admin.id);
    expect((await w.login('mira@x.io', 'member-pass-1')).res.statusCode).toBe(200);
  });

  it('an MCP token of a suspended member stops working at once and works again after reactivation (token not deleted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-mcp-susp-'));
    const auth = new UserAuthStore(dir);
    const admin = await auth.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const b = await auth.createUser({ email: 'b@x.io', password: 'admin-pass-2', isAdmin: true });
    const tokens = new McpTokenStore(dir, auth);
    const { token } = await tokens.create(b.id, 'laptop');
    expect(await tokens.verify(token)).toBeTruthy();
    auth.setSuspended(b.id, true, admin.id);
    expect(await tokens.verify(token)).toBeUndefined();
    expect(await tokens.list(b.id)).toHaveLength(1);
    auth.setSuspended(b.id, false, admin.id);
    expect(await tokens.verify(token)).toBeTruthy();
  });

  it('McpTokenStore.revokeAllFor removes every token of one user, nobody else\'s, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-mcp-revall-'));
    const auth = new UserAuthStore(dir);
    const a = await auth.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const b = await auth.createUser({ email: 'b@x.io', password: 'admin-pass-2', isAdmin: true });
    const tokens = new McpTokenStore(dir, auth);
    await tokens.create(b.id, 'satu'); await tokens.create(b.id, 'dua'); const keep = await tokens.create(a.id, 'milik-a');
    expect(await tokens.revokeAllFor(b.id)).toBe(2);
    expect(await tokens.revokeAllFor(b.id)).toBe(0);
    expect(await tokens.list(b.id)).toEqual([]);
    expect(await tokens.verify(keep.token)).toBeTruthy();
  });
});

describe('T8 DELETE /api/auth/members/:id (C.3): the member goes, the projects stay, every credential is revoked', () => {
  async function seeded() {
    const w = await world();
    const mira = await w.addUser('mira@x.io');
    const bina = await w.addUser('bina@x.io', true); // an admin, so her MCP token verifies today
    const mine = [storyId(), storyId()];
    for (const id of mine) writeStory(w.dataDir, { id, ownerId: mira.user.id, title: `Proyek ${id.slice(-2)}` });
    const others = storyId(); writeStory(w.dataDir, { id: others, ownerId: bina.user.id });
    const adminStory = storyId(); writeStory(w.dataDir, { id: adminStory, ownerId: w.admin.id });
    const mcp = new McpTokenStore(w.dataDir, w.auth);
    await mcp.create(mira.user.id, 'laptop-mira'); const binaToken = await mcp.create(bina.user.id, 'laptop-bina');
    const pub = new PublisherTokenStore(join(w.dataDir, 'publisher'));
    await pub.save(mira.user.id, 'youtube', { accessToken: 'yt-mira' }); await pub.save(bina.user.id, 'youtube', { accessToken: 'yt-bina' });
    return { w, mira, bina, mine, others, adminStory, mcp, binaToken, pub };
  }

  it('removal keeps every project byte-identical (they become orphans), revokes MCP tokens and publisher connections, drops sessions, answers orphanedProjects', async () => {
    const { w, mira, bina, mine, others, mcp, binaToken, pub } = await seeded();
    const snap = Object.fromEntries([...mine, others].map(id => [id, dirBytes(join(w.dataDir, 'stories', id))]));
    const res = await w.req('DELETE', `/api/auth/members/${mira.user.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, orphanedProjects: 2 });
    expect(w.auth.findUserById(mira.user.id)).toBeUndefined();
    expect((await w.req('GET', '/api/auth/me', mira.cookie)).statusCode).toBe(401);
    for (const id of [...mine, others]) expect(dirBytes(join(w.dataDir, 'stories', id)), id).toBe(snap[id]);
    expect(await mcp.list(mira.user.id)).toEqual([]);
    expect(await mcp.verify(binaToken.token)).toBeTruthy();
    expect(await pub.get(mira.user.id, 'youtube')).toBeUndefined();
    expect(existsSync(join(w.dataDir, 'publisher', mira.user.id))).toBe(false);
    expect((await pub.get(bina.user.id, 'youtube'))?.accessToken).toBe('yt-bina');
    // the previous owner stays nameable
    expect(w.auth.findTombstone(mira.user.id)).toMatchObject({ email: 'mira@x.io', removedBy: w.admin.id });
  });

  it('is idempotent and heals a half-done removal: the second call is 200 alreadyRemoved and re-runs the revocations', async () => {
    const { w, mira, mcp, pub } = await seeded();
    expect((await w.req('DELETE', `/api/auth/members/${mira.user.id}`)).statusCode).toBe(200);
    // simulate a crash between the account write and the revocations: credentials of the removed id are back on disk
    await mcp.create(mira.user.id, 'zombie');
    await pub.save(mira.user.id, 'tiktok', { accessToken: 'tt-zombie' });
    const again = await w.req('DELETE', `/api/auth/members/${mira.user.id}`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadyRemoved: true, orphanedProjects: 2 });
    expect(await mcp.list(mira.user.id)).toEqual([]);
    expect(await pub.get(mira.user.id, 'tiktok')).toBeUndefined();
    expect(w.auth.tombstones().filter(t => t.id === mira.user.id)).toHaveLength(1);
    // an id that never existed is still 404
    expect((await w.req('DELETE', '/api/auth/members/u_never')).statusCode).toBe(404);
  });

  it('cannot remove yourself or the last admin (409) and then nothing at all is revoked', async () => {
    const { w, mira, mcp } = await seeded();
    const self = await w.req('DELETE', `/api/auth/members/${w.admin.id}`);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF');
    w.auth.setAdmin(mira.user.id, true, w.admin.id);
    const miraAdminCookie = mira.cookie;
    const last = await w.req('DELETE', `/api/auth/members/${w.admin.id}`, miraAdminCookie);
    expect(last.statusCode).toBe(200); // two admins: allowed
    const lastAgain = await w.req('DELETE', `/api/auth/members/${mira.user.id}`, miraAdminCookie);
    expect(lastAgain.statusCode).toBe(409);
    expect(lastAgain.json().error.code).toMatch(/SELF|LAST_ADMIN/);
    expect(await mcp.list(mira.user.id)).toHaveLength(1);
  });

  it('a member cannot remove anyone (403) and an anonymous caller gets 401', async () => {
    const { w, mira, bina } = await seeded();
    expect((await w.req('DELETE', `/api/auth/members/${bina.user.id}`, mira.cookie)).statusCode).toBe(403);
    expect((await w.req('DELETE', `/api/auth/members/${bina.user.id}`, '')).statusCode).toBe(401);
    expect(w.auth.findUserById(bina.user.id)).toBeTruthy();
  });
});

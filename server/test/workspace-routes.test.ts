/**
 * W2 — workspace routes: /api/workspaces, invites, members and the public join page.
 * RED first: written before `workspace/routes.ts` and `workspace/service.ts` existed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { WorkspaceService, assertWrite } from '../src/workspace/service.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { registerWorkspaceRoutes } from '../src/workspace/routes.js';

const cookie = (token: string) => ({ cookie: `oc_session=${token}` });

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-routes-'));
  const auth = new UserAuthStore(dataDir);
  const owner = await auth.createUser({ email: 'joseph@x.io', password: 'owner-pass-1', isAdmin: true });
  const friend = await auth.createUser({ email: 'friend@x.io', password: 'friend-pass-1', isAdmin: false });
  const store = new WorkspaceStore(dataDir);
  const service = new WorkspaceService({ store, auth, dataDir });
  const server = Fastify();
  await registerWorkspaceRoutes(server, { service, store, auth });
  await server.ready();
  const session = (userId: string) => auth.createSession(userId).token;
  return { dataDir, auth, store, service, server, owner, friend, session, as: (userId: string) => cookie(session(userId)) };
}

type World = Awaited<ReturnType<typeof world>>;
const close = (w: World) => w.server.close();

async function inviteTo(w: World, workspaceId: string, email: string, role: 'editor' | 'viewer', byUserId: string) {
  const res = await w.server.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/invites`, headers: cookie(w.session(byUserId)), payload: { email, role } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { invite: { id: string; email: string; role: string; expiresAtMs: number }; url: string };
}

describe('W2 rute workspace', () => {
  it('needs a login and lists what the caller follows, personal workspace included', async () => {
    const w = await world();
    expect((await w.server.inject({ method: 'GET', url: '/api/workspaces' })).statusCode).toBe(401);
    const personal = await w.service.ensurePersonalForUser(w.owner.id);
    const res = await w.server.inject({ method: 'GET', url: '/api/workspaces', headers: w.as(w.owner.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toEqual([{ id: personal.id, name: personal.name, role: 'owner', personal: true, projects: 0, members: 1 }]);
    expect((await w.server.inject({ method: 'GET', url: '/api/workspaces', headers: w.as(w.friend.id) })).json().workspaces).toEqual([]);
    await close(w);
  });

  it('creates a workspace with the creator as owner, up to five, and refuses the sixth', async () => {
    const w = await world();
    const created = await w.server.inject({ method: 'POST', url: '/api/workspaces', headers: w.as(w.owner.id), payload: { name: '  Tim   Lentera ' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().workspace).toMatchObject({ name: 'Tim Lentera', ownerId: w.owner.id, personal: false });
    expect((await w.server.inject({ method: 'POST', url: '/api/workspaces', headers: w.as(w.owner.id), payload: { name: '' } })).statusCode).toBe(400);
    for (let i = 1; i < 5; i += 1) await w.server.inject({ method: 'POST', url: '/api/workspaces', headers: w.as(w.owner.id), payload: { name: `W${i}` } });
    const sixth = await w.server.inject({ method: 'POST', url: '/api/workspaces', headers: w.as(w.owner.id), payload: { name: 'Keenam' } });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe('LIMIT_WORKSPACE');
    await close(w);
  });

  it('keeps a non-member out with 404 (no oracle) and shows the member list to members only', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    expect((await w.server.inject({ method: 'GET', url: `/api/workspaces/${ws.id}`, headers: w.as(w.friend.id) })).statusCode).toBe(404);
    expect((await w.server.inject({ method: 'GET', url: '/api/workspaces/ws_nope', headers: w.as(w.owner.id) })).statusCode).toBe(404);
    const seen = await w.server.inject({ method: 'GET', url: `/api/workspaces/${ws.id}`, headers: w.as(w.owner.id) });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ workspace: { id: ws.id, name: 'Tim', role: 'owner', personal: false }, members: [{ userId: w.owner.id, email: 'joseph@x.io', role: 'owner' }] });
    expect(seen.json().invites).toEqual([]);
    await close(w);
  });

  it('lets an owner invite editor or viewer, never owner, and shows the link only to the owner', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    const made = await inviteTo(w, ws.id, ' Friend@X.io ', 'editor', w.owner.id);
    expect(made.invite).toMatchObject({ email: 'friend@x.io', role: 'editor' });
    expect(made.url).toMatch(new RegExp(`/join/[A-Za-z0-9_-]{43}$`));
    const token = made.url.split('/join/')[1]!;
    expect((await w.store.peekInvite(token))?.workspaceId).toBe(ws.id);
    await w.store.addMember({ workspaceId: ws.id, userId: w.friend.id, role: 'viewer', byUserId: w.owner.id });
    const denied = await w.server.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/invites`, headers: w.as(w.friend.id), payload: { email: 'x@y.io', role: 'viewer' } });
    expect(denied.statusCode).toBe(403);
    const asMember = await w.server.inject({ method: 'GET', url: `/api/workspaces/${ws.id}`, headers: w.as(w.friend.id) });
    expect(asMember.json().invites).toBeUndefined();
    expect((await w.server.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/invites`, headers: w.as(w.owner.id), payload: { email: 'x@y.io', role: 'owner' } })).statusCode).toBe(400);
    const revoked = await w.server.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/invites/${made.invite.id}`, headers: w.as(w.owner.id) });
    expect(revoked.statusCode).toBe(200);
    expect(w.store.peekInvite(token)).toBeUndefined();
    await close(w);
  });

  it('public join page: name, role, email and needsAccount only — never members or project content', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim Rahasia', ownerId: w.owner.id });
    const made = await inviteTo(w, ws.id, 'new@x.io', 'editor', w.owner.id);
    const token = made.url.split('/join/')[1]!;
    const page = await w.server.inject({ method: 'GET', url: `/api/join/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ workspace: { name: 'Tim Rahasia' }, role: 'editor', email: 'new@x.io', needsAccount: true });
    expect((await w.server.inject({ method: 'GET', url: '/api/join/not-a-token-at-all-really' })).statusCode).toBe(404);
    await close(w);
  });

  it('join with a new account: validates the password, creates the account, signs in, spends the token, opens a personal workspace', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    const made = await inviteTo(w, ws.id, 'new@x.io', 'editor', w.owner.id);
    const token = made.url.split('/join/')[1]!;
    const weak = await w.server.inject({ method: 'POST', url: `/api/join/${token}`, payload: { password: 'pendek' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('WEAK_PASSWORD');
    const joined = await w.server.inject({ method: 'POST', url: `/api/join/${token}`, payload: { password: 'undangan-kuat-1' } });
    expect(joined.statusCode).toBe(200, joined.body);
    expect(joined.json().user.email).toBe('new@x.io');
    expect(String(joined.headers['set-cookie'])).toContain('oc_session=');
    const account = w.auth.findUserByEmail('new@x.io');
    expect(account).toBeDefined();
    expect(w.store.roleOf(account!.id, ws.id)).toBe('editor');
    expect(w.store.personalOf(account!.id)).toBeDefined();
    expect((await w.server.inject({ method: 'GET', url: `/api/join/${token}` })).statusCode).toBe(404);
    expect((await w.server.inject({ method: 'POST', url: `/api/join/${token}`, payload: { password: 'undangan-kuat-2' } })).statusCode).toBe(404);
    await close(w);
  });

  it('join with an existing account requires being signed in as that account', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    const made = await inviteTo(w, ws.id, 'friend@x.io', 'viewer', w.owner.id);
    const token = made.url.split('/join/')[1]!;
    expect((await w.server.inject({ method: 'GET', url: `/api/join/${token}` })).json().needsAccount).toBe(false);
    const anonymous = await w.server.inject({ method: 'POST', url: `/api/join/${token}`, payload: { password: 'whatever-123' } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('MASUK_DULU');
    const wrongUser = await w.server.inject({ method: 'POST', url: `/api/join/${token}`, headers: w.as(w.owner.id), payload: {} });
    expect(wrongUser.statusCode).toBe(403);
    expect(wrongUser.json().error.code).toBe('EMAIL_MISMATCH');
    expect(w.store.peekInvite(token)).toBeDefined();
    const joined = await w.server.inject({ method: 'POST', url: `/api/join/${token}`, headers: w.as(w.friend.id), payload: {} });
    expect(joined.statusCode).toBe(200);
    expect(w.store.roleOf(w.friend.id, ws.id)).toBe('viewer');
    await close(w);
  });

  it('changes roles and removes members under the owner rules (last owner, self-leave, editor 403)', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    await w.store.addMember({ workspaceId: ws.id, userId: w.friend.id, role: 'editor', byUserId: w.owner.id });
    const changed = await w.server.inject({ method: 'PATCH', url: `/api/workspaces/${ws.id}/members/${w.friend.id}`, headers: w.as(w.owner.id), payload: { role: 'viewer' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().member).toMatchObject({ userId: w.friend.id, role: 'viewer' });
    const demoteOwner = await w.server.inject({ method: 'PATCH', url: `/api/workspaces/${ws.id}/members/${w.owner.id}`, headers: w.as(w.owner.id), payload: { role: 'editor' } });
    expect(demoteOwner.statusCode).toBe(409);
    expect(demoteOwner.json().error.code).toBe('LAST_OWNER');
    expect((await w.server.inject({ method: 'PATCH', url: `/api/workspaces/${ws.id}/members/${w.friend.id}`, headers: w.as(w.friend.id), payload: { role: 'editor' } })).statusCode).toBe(403);
    expect((await w.server.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/invites`, headers: w.as(w.friend.id), payload: { email: 'a@b.io', role: 'viewer' } })).statusCode).toBe(403);
    expect((await w.server.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/members/${w.friend.id}`, headers: w.as(w.friend.id) })).statusCode).toBe(200);
    expect(w.store.roleOf(w.friend.id, ws.id)).toBeUndefined();
    await close(w);
  });

  it('a viewer may not write: assertWrite answers undefined, an editor returns the role', async () => {
    const w = await world();
    const ws = await w.store.create({ name: 'Tim', ownerId: w.owner.id });
    await w.store.addMember({ workspaceId: ws.id, userId: w.friend.id, role: 'viewer', byUserId: w.owner.id });
    expect(assertWrite(w.service, w.owner.id, ws.id)).toBe('owner');
    expect(assertWrite(w.service, w.friend.id, ws.id)).toBeUndefined();
    await w.store.setRole({ workspaceId: ws.id, userId: w.friend.id, role: 'editor', byUserId: w.owner.id });
    expect(assertWrite(w.service, w.friend.id, ws.id)).toBe('editor');
    await close(w);
  });
});

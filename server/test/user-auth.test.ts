import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { registerAuthRoutes } from '../src/auth/routes.js';
import { UserAuthStore } from '../src/auth/store.js';

function tempStore(): UserAuthStore {
  return new UserAuthStore(mkdtempSync(join(tmpdir(), 'oc-auth-test-')));
}

describe('password hashing', () => {
  it('hashes and verifies, rejects wrong password', async () => {
    const hash = await hashPassword('correct-horse-9');
    expect(await verifyPassword('correct-horse-9', hash)).toBe(true);
    expect(await verifyPassword('wrong-password-1', hash)).toBe(false);
  });

  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('user auth store', () => {
  it('creates, verifies, sessions round-trip', async () => {
    const store = tempStore();
    expect(store.hasUsers()).toBe(false);
    const user = await store.createUser({ email: 'Admin@Example.com', password: 'admin-pass-1', isAdmin: true });
    expect(user.email).toBe('admin@example.com');
    expect(store.hasUsers()).toBe(true);
    expect(await store.verifyCredentials('admin@example.com', 'admin-pass-1')).toMatchObject({ id: user.id });
    expect(await store.verifyCredentials('admin@example.com', 'nope-nope-no')).toBeUndefined();
    const { token } = store.createSession(user.id);
    expect(store.resolveSession(token)).toMatchObject({ id: user.id });
    store.destroySession(token);
    expect(store.resolveSession(token)).toBeUndefined();
  });

  it('invite lifecycle: create, peek, accept, single-use', async () => {
    const store = tempStore();
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const { token, invite } = store.createInvite({ email: 'friend@x.io', createdBy: admin.id });
    expect(store.peekInvite(token)).toMatchObject({ tokenHash: invite.tokenHash });
    await expect(store.acceptInvite({ token, email: 'other@x.io', password: 'friend-pass-1' })).rejects.toThrow();
    const user = await store.acceptInvite({ token, email: 'friend@x.io', password: 'friend-pass-1' });
    expect(user.isAdmin).toBe(false);
    await expect(store.acceptInvite({ token, email: 'friend@x.io', password: 'friend-pass-1' })).rejects.toThrow();
  });
});

describe('auth routes', () => {
  async function app() {
    const server = Fastify();
    await registerAuthRoutes(server, tempStore(), {
      bootstrapAdminEmail: 'admin@x.io',
      bootstrapAdminPassword: 'bootstrap-pass-1'
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    return server;
  }

  it('setup-admin is disabled (invitation-only); bootstrap comes from env', async () => {
    const server = Fastify();
    const store = tempStore();
    await registerAuthRoutes(server, store, {
      bootstrapAdminEmail: 'admin@x.io',
      bootstrapAdminPassword: 'bootstrap-pass-1'
    });
    // bootstrap is awaited by registerAuthRoutes — no sleeping for the hash
    expect(store.hasUsers()).toBe(true);
    const denied = await server.inject({ method: 'POST', url: '/auth/setup-admin', payload: { email: 'stranger@x.io', password: 'stranger-pass-1' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('INVITE_ONLY');
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@x.io', password: 'bootstrap-pass-1' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const me = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'admin@x.io', isAdmin: true });
    const bad = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@x.io', password: 'wrong-wrong-wrong' } });
    expect(bad.statusCode).toBe(401);
    const out = await server.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const meAfter = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });

  it('invites are admin-only and accept creates a session', async () => {
    const server = await app();
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@x.io', password: 'bootstrap-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const created = await server.inject({ method: 'POST', url: '/auth/invites', headers: { cookie }, payload: { email: 'friend@x.io' } });
    expect(created.statusCode).toBe(200);
    const { token } = created.json() as { token: string };
    const peek = await server.inject({ method: 'GET', url: `/auth/invites/peek?token=${token}` });
    expect(peek.json()).toMatchObject({ valid: true, email: 'friend@x.io' });
    const accept = await server.inject({ method: 'POST', url: '/auth/invites/accept', payload: { token, email: 'friend@x.io', password: 'friend-pass-1' } });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().user.isAdmin).toBe(false);
    const list = await server.inject({ method: 'GET', url: '/auth/invites', headers: { cookie } });
    expect(list.json().invites[0].usedAt).toBeTruthy();
  });
});

describe('change password', () => {
  it('verifies current password before updating', async () => {
    const store = tempStore();
    const user = await store.createUser({ email: 'u@x.io', password: 'old-pass-12', isAdmin: false });
    await expect(store.changePassword(user.id, 'wrong-wrong', 'new-pass-12')).rejects.toThrow();
    await expect(store.changePassword(user.id, 'old-pass-12', 'short')).rejects.toThrow();
    await store.changePassword(user.id, 'old-pass-12', 'new-pass-12');
    expect(await store.verifyCredentials('u@x.io', 'new-pass-12')).toMatchObject({ id: user.id });
    expect(await store.verifyCredentials('u@x.io', 'old-pass-12')).toBeUndefined();
  });
});

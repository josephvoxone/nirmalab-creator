import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';

describe('revoked invites are told apart from used ones', () => {
  it('revokeInvite stamps revokedAt and the token stops working', async () => {
    const store = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-inv-')));
    const admin = await store.createUser({ email: 'a@x.io', password: 'secret-pass-1', isAdmin: true });
    const { token, invite } = store.createInvite({ email: 'b@x.io', createdBy: admin.id });
    expect(store.revokeInvite(invite.tokenHash, admin.id)).toBe(true);
    const listed = store.listInvites().find(i => i.tokenHash === invite.tokenHash)!;
    expect(listed.revokedAt).toBeTruthy();
    expect(store.peekInvite(token)).toBeUndefined();
  });

  it('removing a member revokes (not "uses") their open invites', async () => {
    const store = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-inv-')));
    const a = await store.createUser({ email: 'a@x.io', password: 'secret-pass-1', isAdmin: true });
    const b = await store.createUser({ email: 'b@x.io', password: 'secret-pass-1', isAdmin: true });
    const { invite } = store.createInvite({ createdBy: b.id });
    store.removeUser(b.id, a.id);
    expect(store.listInvites().find(i => i.tokenHash === invite.tokenHash)!.revokedAt).toBeTruthy();
  });
});

describe('GET /auth/invites exposes revokedAt', () => {
  it('lists a revoked invite with revokedAt', async () => {
    const { default: Fastify } = await import('fastify');
    const { SESSION_COOKIE, registerAuthRoutes } = await import('../src/auth/routes.js');
    const server = Fastify();
    const store = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-inv-')));
    await registerAuthRoutes(server, store, { bootstrapAdminEmail: 'admin@x.io', bootstrapAdminPassword: 'bootstrap-pass-1' });
    const admin = store.findUserByEmail('admin@x.io')!;
    const { invite } = store.createInvite({ createdBy: admin.id });
    store.revokeInvite(invite.tokenHash, admin.id);
    const r = await server.inject({ method: 'GET', url: '/auth/invites', headers: { cookie: `${SESSION_COOKIE}=${store.createSession(admin.id).token}` } });
    expect(r.json().invites[0].revokedAt).toBeTruthy();
  });
});

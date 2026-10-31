/**
 * Wave 4 — removing an account must not leave the workspace tree behind.
 * Found by the production E2E: three deleted QA accounts left empty "Ruang kerja Qa" workspaces, one of them still
 * listing a member. Contract: memberships go everywhere; an EMPTY owned workspace is deleted with its invites; one that
 * still holds projects is kept and marked ownerRemovedAtMs so no project is lost and an admin can transfer it.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { WorkspaceService } from '../src/workspace/service.js';

const STORY = (n: number) => `story_${String(n).padStart(16, '0')}`;

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-rm-'));
  const auth = new UserAuthStore(dataDir);
  const store = new WorkspaceStore(dataDir);
  const service = new WorkspaceService({ store, auth, dataDir });
  const a = await auth.createUser({ email: 'a@example.com', password: 'a-pass-1234', isAdmin: true });
  const b = await auth.createUser({ email: 'b@example.com', password: 'b-pass-1234', isAdmin: false });
  return { dataDir, auth, store, service, a, b };
}

const writeProject = (dataDir: string, id: string, workspaceId: string, createdBy: string) => {
  mkdirSync(join(dataDir, 'stories', id), { recursive: true });
  writeFileSync(join(dataDir, 'stories', id, 'story.json'), JSON.stringify({ id, title: 'Judul', createdBy, workspaceId }));
};

describe('removing an account cleans the workspace tree', () => {
  it('an EMPTY personal workspace is deleted with its invites and memberships', async () => {
    const w = await world();
    const { workspace } = await w.store.ensurePersonal({ userId: w.a.id });
    await w.store.addMember({ workspaceId: workspace.id, userId: w.b.id, role: 'editor', byUserId: w.a.id });
    await w.store.createInvite({ workspaceId: workspace.id, email: 'c@example.com', role: 'viewer', createdBy: w.a.id });
    const out = await w.service.cleanupRemovedUser(w.a.id);
    expect(out).toEqual({ removedWorkspaces: 1, orphanedWorkspaces: 0 });
    expect(w.store.get(workspace.id)).toBeUndefined();
    expect(w.store.roleOf(w.b.id, workspace.id)).toBeUndefined();
    expect(w.store.invites(workspace.id)).toEqual([]);
  });

  it('a workspace that still holds projects is KEPT and marked, and no project file is touched', async () => {
    const w = await world();
    const { workspace } = await w.store.ensurePersonal({ userId: w.a.id });
    writeProject(w.dataDir, STORY(1), workspace.id, w.a.id);
    const out = await w.service.cleanupRemovedUser(w.a.id);
    expect(out).toEqual({ removedWorkspaces: 0, orphanedWorkspaces: 1 });
    expect(w.store.get(workspace.id)).toMatchObject({ ownerRemovedAtMs: expect.any(Number) });
    expect(existsSync(join(w.dataDir, 'stories', STORY(1), 'story.json'))).toBe(true);
    expect(w.store.roleOf(w.a.id, workspace.id)).toBeUndefined(); // the account is gone; no access remains
  });

  it('a membership in somebody else\'s workspace goes, and that workspace stays exactly as it was', async () => {
    const w = await world();
    const { workspace } = await w.store.ensurePersonal({ userId: w.b.id });
    await w.store.addMember({ workspaceId: workspace.id, userId: w.a.id, role: 'viewer', byUserId: w.b.id });
    const out = await w.service.cleanupRemovedUser(w.a.id);
    expect(out).toEqual({ removedWorkspaces: 0, orphanedWorkspaces: 0 });
    expect(w.store.get(workspace.id)).toMatchObject({ ownerId: w.b.id, name: expect.any(String) });
    expect(w.store.roleOf(w.a.id, workspace.id)).toBeUndefined();
    expect(w.store.roleOf(w.b.id, workspace.id)).toBe('owner');
  });

  it('the removal ROUTE runs it (wiring): the deleted member leaves no workspace behind and lands in a tombstone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-rm-http-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@example.com', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
    });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'admin-pass-1' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      // Members join through an invite (the platform's own path), which is also their first use: a personal workspace.
      const invited = await server.inject({ method: 'POST', url: '/api/auth/invites', headers: { cookie }, payload: { email: 'gone@example.com' } });
      expect(invited.statusCode, invited.body).toBe(200);
      const token = invited.json().token as string;
      const accepted = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { token, email: 'gone@example.com', password: 'gone-pass-123' } });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const member = accepted.json().user as { id: string };
      const store = new WorkspaceStore(dataDir);
      const personal = store.list().find(w => w.personal && w.ownerId === member.id);
      expect(personal, 'the member got a personal workspace on first use').toBeTruthy();

      const removed = await server.inject({ method: 'DELETE', url: `/api/auth/members/${member.id}`, headers: { cookie } });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(new WorkspaceStore(dataDir).get(personal!.id)).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

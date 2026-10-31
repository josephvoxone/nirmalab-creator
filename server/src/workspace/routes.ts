/**
 * W2 — workspace routes (audit wave 4, PIN contract).
 *
 *   GET    /api/workspaces                         every workspace the caller follows (role, personal, projects, members)
 *   POST   /api/workspaces {name}                  one more (max 5 per person); the creator is its owner
 *   GET    /api/workspaces/:id                     workspace + members (invites only for the owner)
 *   DELETE /api/workspaces/:id                     owner only, never a personal workspace; projects are NOT deleted
 *   POST   /api/workspaces/:id/invites {email,role}     owner only; returns the one-time link
 *   DELETE /api/workspaces/:id/invites/:inviteId        owner only; revoke
 *   PATCH  /api/workspaces/:id/members/:userId {role}   owner only; never the last owner
 *   DELETE /api/workspaces/:id/members/:userId          owner, or the member leaving on their own
 *   GET    /api/join/:token                        PUBLIC: workspace name, role, email, needsAccount — nothing else
 *   POST   /api/join/:token {password?}            PUBLIC: join, or create the invited account and sign in
 *
 * A non-member gets the SAME 404 as an unknown id (no oracle); a viewer writing gets 403 `VIEWER_READ_ONLY` with an Indonesian
 * message. Policy entries live in tenancy/policy.ts (PUBLIK for /api/join, PENGGUNA-* for the rest).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, sessionUser, startSession } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { AuditInput } from '../tenancy/audit-log.js';
import { WorkspaceError } from './store.js';
import type { WorkspaceService } from './service.js';
import type { WorkspaceStore } from './store.js';

export type WorkspaceRouteOptions = {
  service: WorkspaceService;
  store: WorkspaceStore;
  auth: UserAuthStore;
  /** `COOKIE_SECURE` of the auth routes: the join route signs a new account in with the same cookie rules. */
  secureCookies?: 'auto' | boolean;
  /** Admin trail: who joined which workspace (never project content). */
  audit?: (entry: AuditInput) => Promise<void>;
};

const err = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{8,64}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,80}$/;
const INVITE_ID = /^wi_[A-Za-z0-9_-]{6,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

/** One mapping of the store's error codes to HTTP, so every route answers the same thing for the same rule. */
function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof WorkspaceError)) throw error;
  switch (error.code) {
    case 'NOT_FOUND': return err(reply, 404, 'NOT_FOUND', 'Workspace tidak ditemukan');
    case 'INVITE_INVALID': return err(reply, 404, 'INVITE_INVALID', error.message);
    case 'FORBIDDEN': return err(reply, 403, 'FORBIDDEN', error.message);
    case 'LAST_OWNER': return err(reply, 409, 'LAST_OWNER', error.message);
    case 'PERSONAL': return err(reply, 409, 'PERSONAL', error.message);
    case 'LIMIT': return err(reply, 409, 'LIMIT_WORKSPACE', error.message);
    case 'ALREADY_MEMBER': return err(reply, 409, 'ALREADY_MEMBER', error.message);
    case 'EMAIL_MISMATCH': return err(reply, 403, 'EMAIL_MISMATCH', error.message);
    default: return err(reply, 400, error.code === 'INVALID' ? 'INVALID_INPUT' : 'INVALID_INPUT', error.message);
  }
}

export async function registerWorkspaceRoutes(server: FastifyInstance, options: WorkspaceRouteOptions): Promise<void> {
  const { service, store, auth } = options;
  const secureCookies = options.secureCookies ?? 'auto';
  const record = (entry: AuditInput) => options.audit?.(entry).catch(() => undefined);

  const me = (request: FastifyRequest) => sessionUser(auth, request);

  server.get('/api/workspaces', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    return { workspaces: await service.listForUser(user.id) };
  });

  server.post<{ Body: { name?: unknown } | undefined }>('/api/workspaces', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    try {
      const workspace = await store.create({ name: request.body?.name, ownerId: user.id });
      await record({ by: user.id, action: 'workspace.buat', targetId: workspace.id, detail: { name: workspace.name } });
      return { workspace };
    } catch (error) { return sendError(reply, error); }
  });

  server.get<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id)) return err(reply, 404, 'NOT_FOUND', 'Workspace tidak ditemukan');
    try { return service.detail(request.params.id, user.id); } catch (error) { return sendError(reply, error); }
  });

  server.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id)) return err(reply, 404, 'NOT_FOUND', 'Workspace tidak ditemukan');
    try {
      await store.deleteWorkspace({ workspaceId: request.params.id, byUserId: user.id });
      await record({ by: user.id, action: 'workspace.hapus', targetId: request.params.id });
      return { ok: true };
    } catch (error) { return sendError(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { email?: unknown; role?: unknown } | undefined }>('/api/workspaces/:id/invites', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id)) return err(reply, 404, 'NOT_FOUND', 'Workspace tidak ditemukan');
    try {
      const { invite, token } = await store.createInvite({ workspaceId: request.params.id, email: request.body?.email, role: request.body?.role, createdBy: user.id });
      await record({ by: user.id, action: 'workspace.undang', targetId: request.params.id, targetEmail: invite.email, detail: { role: invite.role } });
      const host = request.headers.host ?? 'localhost';
      return { invite: { id: invite.id, email: invite.email, role: invite.role, expiresAtMs: invite.expiresAtMs }, url: `${request.protocol}://${host}/join/${token}` };
    } catch (error) { return sendError(reply, error); }
  });

  server.delete<{ Params: { id: string; inviteId: string } }>('/api/workspaces/:id/invites/:inviteId', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id) || !INVITE_ID.test(request.params.inviteId)) return err(reply, 404, 'NOT_FOUND', 'Undangan tidak ditemukan');
    try {
      await store.revokeInvite({ workspaceId: request.params.id, inviteId: request.params.inviteId, byUserId: user.id });
      return { ok: true };
    } catch (error) { return sendError(reply, error); }
  });

  server.patch<{ Params: { id: string; userId: string }; Body: { role?: unknown } | undefined }>('/api/workspaces/:id/members/:userId', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id) || !USER_ID.test(request.params.userId)) return err(reply, 404, 'NOT_FOUND', 'Anggota tidak ditemukan');
    const role = request.body?.role;
    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') return err(reply, 400, 'INVALID_INPUT', 'Peran harus owner, editor atau viewer');
    try {
      const member = await store.setRole({ workspaceId: request.params.id, userId: request.params.userId, role, byUserId: user.id });
      await record({ by: user.id, action: 'workspace.peran', targetId: request.params.id, targetEmail: auth.findUserById(member.userId)?.email, detail: { role } });
      return { member };
    } catch (error) { return sendError(reply, error); }
  });

  server.delete<{ Params: { id: string; userId: string } }>('/api/workspaces/:id/members/:userId', async (request, reply) => {
    const user = me(request);
    if (!user) return err(reply, 401, 'UNAUTHORIZED', 'Masuk dulu');
    if (!WORKSPACE_ID.test(request.params.id) || !USER_ID.test(request.params.userId)) return err(reply, 404, 'NOT_FOUND', 'Anggota tidak ditemukan');
    try {
      await store.removeMember({ workspaceId: request.params.id, userId: request.params.userId, byUserId: user.id });
      await record({ by: user.id, action: 'workspace.keluar', targetId: request.params.id, targetEmail: auth.findUserById(request.params.userId)?.email });
      return { ok: true };
    } catch (error) { return sendError(reply, error); }
  });

  // ------------------------------------------------------------------ public join page

  server.get<{ Params: { token: string } }>('/api/join/:token', async (request, reply) => {
    if (!TOKEN.test(request.params.token)) return err(reply, 404, 'INVITE_INVALID', 'Undangan tidak ditemukan atau sudah tidak berlaku');
    const preview = service.joinPreview(request.params.token);
    if (!preview) return err(reply, 404, 'INVITE_INVALID', 'Undangan tidak ditemukan atau sudah tidak berlaku');
    // Exactly four fields: the workspace name, the role on offer, the addressed address, and whether an account is needed.
    return { workspace: { name: preview.name }, role: preview.role, email: preview.email, needsAccount: preview.needsAccount };
  });

  server.post<{ Params: { token: string }; Body: { password?: unknown } | undefined }>('/api/join/:token', async (request, reply) => {
    const token = request.params.token;
    if (!TOKEN.test(token)) return err(reply, 404, 'INVITE_INVALID', 'Undangan tidak ditemukan atau sudah tidak berlaku');
    const preview = service.joinPreview(token);
    if (!preview) return err(reply, 404, 'INVITE_INVALID', 'Undangan tidak ditemukan atau sudah tidak berlaku');
    const signedIn = me(request);
    try {
      if (preview.needsAccount) {
        const password = typeof request.body?.password === 'string' ? request.body.password : '';
        if (!password) return err(reply, 400, 'PASSWORD_REQUIRED', 'Buat password dulu untuk akun baru Anda (8 karakter atau lebih)');
        if (password.length < 8 || password.length > 256) return err(reply, 400, 'WEAK_PASSWORD', 'Password harus 8-256 karakter');
        const joined = await service.joinWithNewAccount(token, password, secureCookies, userId => { startSession(auth, request, reply, userId, secureCookies); });
        await record({ by: joined.user.id, action: 'workspace.gabung', targetId: joined.workspace.id, targetEmail: joined.user.email, detail: { role: joined.role, akunBaru: true } });
        return { user: auth.publicUser(joined.user), workspace: { id: joined.workspace.id, name: joined.workspace.name }, role: joined.role };
      }
      if (!signedIn) {
        return err(reply, 401, 'MASUK_DULU', `Masuk dulu dengan akun ${preview.email}, lalu buka tautan undangan ini lagi.`);
      }
      const joined = await service.joinAsUser(token, signedIn);
      await record({ by: signedIn.id, action: 'workspace.gabung', targetId: joined.workspace.id, targetEmail: signedIn.email, detail: { role: joined.role } });
      return { user: auth.publicUser(signedIn), workspace: { id: joined.workspace.id, name: joined.workspace.name }, role: joined.role };
    } catch (error) { return sendError(reply, error); }
  });

  /** The cookie name this file's join route sets (a test seam; the value lives in auth/routes.ts). */
  void SESSION_COOKIE;
}

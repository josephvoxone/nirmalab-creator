import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isValidEmail, normalizeEmail } from './password.js';
import { MemberError, UserAuthStore, type Tombstone } from './store.js';
import { isCloudflarePeer, resolveClientIp } from './proxy.js';

export const SESSION_COOKIE = 'oc_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

type Attempt = { count: number; resetAt: number };
const loginAttempts = new Map<string, Attempt>();

/**
 * The address the rate limit is keyed on: Fastify's `request.ip`, which honours `trustProxy` as a NUMBER OF HOPS
 * (see ./proxy.ts). Never read X-Forwarded-For here: its left side is written by the client.
 */
function clientIp(request: FastifyRequest): string {
  return resolveClientIp(request.ip || 'unknown', request.headers['cf-connecting-ip']);
}

/** Expired windows are dropped once the table is this big, so many different keys cannot grow memory without bound. */
const LOGIN_TABLE_SWEEP_AT = 5000;
export const loginAttemptCount = (): number => loginAttempts.size;

function loginAllowed(key: string): boolean {
  const now = Date.now();
  if (loginAttempts.size >= LOGIN_TABLE_SWEEP_AT) {
    for (const [k, v] of loginAttempts) if (v.resetAt < now) loginAttempts.delete(k);
    // Still full of live windows (an attack): drop the oldest windows rather than grow.
    for (const k of loginAttempts.keys()) {
      if (loginAttempts.size < LOGIN_TABLE_SWEEP_AT) break;
      loginAttempts.delete(k);
    }
  }
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (/^[A-Za-z0-9_-]{20,128}$/.test(value)) return value;
  }
  return undefined;
}

export function sessionUser(store: UserAuthStore, request: FastifyRequest) {
  const token = readSessionToken(request);
  if (!token) return undefined;
  return store.resolveSession(token);
}

export type AuthRouteOptions = {
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  /** The trusted-proxy hop count `buildApp` gave Fastify (reported by the admin diagnostic only). */
  trustProxyHops?: number;
  /**
   * Session cookie `Secure` attribute: 'auto' (default) = only when the request arrived over HTTPS (Fastify's
   * `request.protocol`, which believes X-Forwarded-Proto only from a trusted proxy hop), true/false = always/never.
   * `Secure` on a plain-http page would make the browser drop the cookie, so auto is the safe default.
   */
  secureCookies?: 'auto' | boolean;
  /**
   * Called once an account has been removed (and again on a retry of the same removal): revokes what hangs on the account
   * (MCP tokens, publisher connections) and reports how many projects were left without an owner. Must be idempotent.
   */
  onMemberRemoved?: (member: Tombstone) => Promise<{ orphanedProjects: number }>;
  /** Called after an admin action on an account (remove / suspend / role); a failing recorder never fails the action. */
  audit?: (entry: { by: string; action: string; targetId: string; targetEmail?: string; detail?: Record<string, string | number | boolean | null> }) => Promise<void>;
};

async function bootstrapAdminIfNeeded(store: UserAuthStore, options: AuthRouteOptions): Promise<void> {
  if (store.hasUsers()) return;
  const email = options.bootstrapAdminEmail?.trim().toLowerCase();
  const password = options.bootstrapAdminPassword ?? '';
  if (!email || password.length < 8) return;
  try {
    await store.createUser({ email, password, isAdmin: true });
    console.log(`[auth] bootstrapped admin ${email} from environment`);
  } catch (error) {
    console.error(`[auth] admin bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function registerAuthRoutes(
  server: FastifyInstance,
  store: UserAuthStore,
  options: AuthRouteOptions = {}
): Promise<void> {
  await bootstrapAdminIfNeeded(store, options);
  const secureCookies = options.secureCookies ?? 'auto';

  server.get('/auth/status', async () => ({ hasUsers: store.hasUsers() }));

  server.post<{ Body: { email?: unknown; password?: unknown } }>('/auth/setup-admin', async (request, reply) => {
    // Invitation-only: public setup is disabled. First admin comes from
    // ADMIN_EMAIL + ADMIN_PASSWORD at boot.
    void request;
    return reply.code(403).send({ error: { code: 'INVITE_ONLY', message: 'Accounts are created by invitation only' } });
  });

  server.post<{ Body: { email?: unknown; password?: unknown } }>('/auth/login', async (request, reply) => {
    const email = typeof request.body?.email === 'string' ? request.body.email : '';
    if (!loginAllowed(`${clientIp(request)}:${normalizeEmail(email)}`)) {
      return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts, try later' } });
    }
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const user = await store.verifyCredentials(email, password);
    if (!user) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' } });
    }
    // Said only after the right password, so the message cannot be used to learn which emails exist.
    if (user.suspendedAt) {
      return reply.code(403).send({ error: { code: 'ACCOUNT_SUSPENDED', message: 'Akun ini ditangguhkan oleh pengelola. Hubungi pengelola untuk mengaktifkannya kembali; proyek Anda tetap aman.' } });
    }
    const session = store.createSession(user.id);
    setSessionCookie(request, reply, session.token, secureCookies);
    return { user: store.publicUser(user) };
  });

  server.post('/auth/logout', async (request, reply) => {
    const token = readSessionToken(request);
    if (token) store.destroySession(token);
    clearSessionCookie(request, reply, secureCookies);
    return { ok: true };
  });

  server.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>('/auth/change-password', async (request, reply) => {
    const user = sessionUser(store, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const currentPassword = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
    const newPassword = typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';
    try {
      await store.changePassword(user.id, currentPassword, newPassword);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed';
      const code = message.includes('8-256') ? 'WEAK_PASSWORD' : 'WRONG_PASSWORD';
      return reply.code(400).send({ error: { code, message } });
    }
  });

  // Admin diagnostic for the proxy chain: what the app resolves as the client address and why. No secrets
  // (admin only; shows the caller's own request). Lets the operator confirm TRUST_PROXY_HOPS without shell access.
  server.get('/auth/client-ip', async (request, reply) => {
    if (!requireAdmin(store, request, reply)) return undefined;
    const forwarded = request.headers['x-forwarded-for'];
    return {
      ip: clientIp(request),
      edge: request.ip,
      viaCloudflare: isCloudflarePeer(request.ip),
      cfConnectingIp: request.headers['cf-connecting-ip'] ?? null,
      hops: options.trustProxyHops ?? null,
      socket: request.socket.remoteAddress ?? null,
      xForwardedFor: Array.isArray(forwarded) ? forwarded.join(', ') : forwarded ?? null,
      xForwardedProto: request.headers['x-forwarded-proto'] ?? null,
      protocol: request.protocol
    };
  });

  server.get('/auth/me', async (request, reply) => {
    const user = sessionUser(store, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return { user: store.publicUser(user) };
  });

  server.post<{ Body: { email?: unknown } }>('/auth/invites', async (request, reply) => {
    const user = requireAdmin(store, request, reply);
    if (!user) return undefined;
    const rawEmail = typeof request.body?.email === 'string' ? request.body.email : '';
    const email = rawEmail.trim();
    if (email && !isValidEmail(email)) {
      return reply.code(400).send({ error: { code: 'INVALID_EMAIL', message: 'Valid email required' } });
    }
    const created = store.createInvite({ email: email || undefined, createdBy: user.id });
    return { token: created.token, expiresAt: created.invite.expiresAt, email: created.invite.email };
  });

  server.get('/auth/invites', async (request, reply) => {
    const user = requireAdmin(store, request, reply);
    if (!user) return undefined;
    return {
      invites: store.listInvites().map(invite => ({
        tokenHash: invite.tokenHash,
        email: invite.email,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        usedAt: invite.usedAt,
        ...(invite.revokedAt ? { revokedAt: invite.revokedAt } : {}),
        createdBy: invite.createdBy
      }))
    };
  });

  server.post<{ Body: { tokenHash?: unknown } }>('/auth/invites/revoke', async (request, reply) => {
    const user = sessionUser(store, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const tokenHash = typeof request.body?.tokenHash === 'string' ? request.body.tokenHash : '';
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
      return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Invalid token' } });
    }
    const ok = store.revokeInvite(tokenHash, user.id);
    if (!ok) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Cannot revoke' } });
    return { ok: true };
  });

  server.get('/auth/members', async (request, reply) => {
    const user = requireAdmin(store, request, reply);
    if (!user) return undefined;
    return { members: store.listUsers() };
  });

  server.patch<{ Params: { id: string }; Body: { isAdmin?: unknown } }>('/auth/members/:id', async (request, reply) => {
    const user = requireAdmin(store, request, reply);
    if (!user) return undefined;
    const isAdmin = request.body?.isAdmin;
    if (typeof isAdmin !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'isAdmin must be true or false' } });
    }
    try {
      return { member: store.setAdmin(request.params.id, isAdmin, user.id) };
    } catch (error) {
      return sendMemberError(reply, error);
    }
  });

  server.delete<{ Params: { id: string } }>('/auth/members/:id', async (request, reply) => {
    const user = requireAdmin(store, request, reply);
    if (!user) return undefined;
    let tombstone: Tombstone;
    let alreadyRemoved = false;
    try {
      tombstone = store.removeUser(request.params.id, user.id);
    } catch (error) {
      // A retry of a removal that already happened: finish the revocations the first attempt may not have reached.
      const earlier = error instanceof MemberError && error.code === 'NOT_FOUND' ? store.findTombstone(request.params.id) : undefined;
      if (!earlier) return sendMemberError(reply, error);
      tombstone = earlier;
      alreadyRemoved = true;
    }
    if (!alreadyRemoved) await options.audit?.({ by: user.id, action: 'anggota.hapus', targetId: tombstone.id, targetEmail: tombstone.email }).catch(() => undefined);
    const cleanup = await options.onMemberRemoved?.(tombstone) ?? { orphanedProjects: 0 };
    return { ok: true, orphanedProjects: cleanup.orphanedProjects, ...(alreadyRemoved ? { alreadyRemoved: true } : {}) };
  });

  server.get<{ Querystring: { token?: string } }>('/auth/invites/peek', async request => {
    const invite = typeof request.query.token === 'string' && request.query.token
      ? store.peekInvite(request.query.token)
      : undefined;
    return { valid: invite !== undefined, email: invite?.email };
  });

  server.post<{ Body: { token?: unknown; email?: unknown; password?: unknown } }>(
    '/auth/invites/accept',
    async (request, reply) => {
      const token = typeof request.body?.token === 'string' ? request.body.token : '';
      const email = typeof request.body?.email === 'string' ? request.body.email : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(token) || !isValidEmail(email)) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Valid token, email and password required' } });
      }
      try {
        const user = await store.acceptInvite({ token, email, password });
        const session = store.createSession(user.id);
        setSessionCookie(request, reply, session.token, secureCookies);
        return { user: store.publicUser(user) };
      } catch (error) {
        return reply.code(400).send({
          error: { code: 'INVITE_FAILED', message: error instanceof Error ? error.message : 'Failed' }
        });
      }
    }
  );
}

export function requireAdmin(store: UserAuthStore, request: FastifyRequest, reply: FastifyReply) {
  const user = sessionUser(store, request);
  if (!user) {
    void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return undefined;
  }
  if (!user.isAdmin) {
    void reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin only' } });
    return undefined;
  }
  return user;
}

function sendMemberError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof MemberError)) throw error;
  const status = error.code === 'NOT_FOUND' ? 404 : 409;
  return reply.code(status).send({ error: { code: error.code, message: error.message } });
}

const cookieSecure = (request: FastifyRequest, mode: 'auto' | boolean): string =>
  (mode === 'auto' ? request.protocol === 'https' : mode) ? '; Secure' : '';

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string, mode: 'auto' | boolean): void {
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${cookieSecure(request, mode)}`
  );
}

function clearSessionCookie(request: FastifyRequest, reply: FastifyReply, mode: 'auto' | boolean): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=deleted; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure(request, mode)}`);
}

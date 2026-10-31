/**
 * Admin API of the per-user limits. Numbers only: nothing here reads or returns anything inside a project.
 *   GET /api/quota/limits/:userId   own overrides + effective limits + usage of that user
 *   PUT /api/quota/limits/:userId   { limits: { elevenChars: { perDay, per30d, perRender }, flowCredits: {...}, ... } }
 *                                   replaces the overrides ({} = back to the defaults; null in a field = no limit)
 *   GET /api/quota/usage?days=7     spend per user per provider (committed), for the admin's overview
 */
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { SpendLedger } from './ledger.js';
import { DEFAULT_LIMITS, LimitInputError, parseUserLimits, type LimitsStore } from './limits.js';

const USER_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type QuotaLimitRouteOptions = { userAuthStore: UserAuthStore; ledger: SpendLedger; limits: LimitsStore };

export async function registerQuotaLimitRoutes(server: FastifyInstance, options: QuotaLimitRouteOptions): Promise<void> {
  const { userAuthStore: auth, ledger, limits } = options;
  const view = async (userId: string) => {
    const user = auth.findUserById(userId);
    if (!user) return undefined;
    return {
      userId: user.id, email: user.email, isAdmin: user.isAdmin,
      limits: await limits.overrides(user.id), effective: limits.effective(user.id),
      defaults: user.isAdmin ? DEFAULT_LIMITS.admin : DEFAULT_LIMITS.member,
      usage: await ledger.usage(user.id)
    };
  };

  server.get<{ Params: { userId: string } }>('/api/quota/limits/:userId', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = USER_ID.test(request.params.userId) ? await view(request.params.userId) : undefined;
    if (!body) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Pengguna tidak ditemukan' } });
    return body;
  });

  server.put<{ Params: { userId: string }; Body: { limits?: unknown } | undefined }>('/api/quota/limits/:userId', async (request, reply) => {
    const admin = requireAdmin(auth, request, reply);
    if (!admin) return undefined;
    if (!USER_ID.test(request.params.userId) || !auth.findUserById(request.params.userId)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Pengguna tidak ditemukan' } });
    let parsed;
    try { parsed = parseUserLimits(request.body?.limits ?? {}); } catch (error) {
      if (error instanceof LimitInputError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: error.message } });
      throw error;
    }
    await limits.set(request.params.userId, parsed);
    request.log.info({ by: admin.id, userId: request.params.userId, kinds: Object.keys(parsed) }, 'quota limits changed');
    return view(request.params.userId);
  });

  server.get<{ Querystring: { days?: string } }>('/api/quota/usage', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const days = Math.min(62, Math.max(1, Math.floor(Number(request.query.days ?? 7)) || 7));
    const rows = await ledger.summary(days);
    const known = new Map(auth.listUsers().map(u => [u.id, u.email] as const));
    return { days, users: rows.map(row => ({ ...row, email: known.get(row.userId) ?? null })) };
  });
}

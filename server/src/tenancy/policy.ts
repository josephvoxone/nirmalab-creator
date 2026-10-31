import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../auth/routes.js';

/**
 * Route policy registry (audit 06 §A.4): EVERY route the server registers has one entry, derived mechanically
 * from `research/audit-2026-10-31/06-route-table.json` (121 rows = 118 at 58b44cc + 3 of wave 1).
 *
 *   PUBLIK            no login (health, login, invite accept, OAuth callback, SPA files)
 *   PENGGUNA-PEMILIK  an object owned by the caller (a project, a Flow job, a generated file) or the caller's own account
 *   PENGGUNA-BERSAMA  login only, nothing owned (catalogues, shared status)
 *   SISTEM-ADMIN      system administration (accounts, providers, keys, invites, members)
 *   BRIDGE-TOKEN      the Flow bridge, its own shared token
 *   MCP-TOKEN         a personal MCP token (bearer)
 *
 * T0 enforces ONE thing: the server does not boot with a route that has no entry (`installPolicyGuard`). The per-handler
 * guards stay exactly as they are; the policy is not enforced on requests yet, only REPORTED (see `report`).
 * A new route therefore needs an entry here (or `config: { policy }` on the route itself) in the same commit.
 */
export type Policy = 'PUBLIK' | 'PENGGUNA-PEMILIK' | 'PENGGUNA-BERSAMA' | 'SISTEM-ADMIN' | 'BRIDGE-TOKEN' | 'MCP-TOKEN';
/** What the route is about: `story:*` = a project id in the path/body, `self` = the caller's own account/connection/new object. */
export type Resource = 'story:id' | 'story:storyId' | 'story:body.storyId' | 'flowjob:id' | 'genfile' | 'self' | 'token' | 'oauth-state';
export type RoutePolicy = { policy: Policy; resource?: Resource };
export type PolicyRegistry = Record<string, RoutePolicy>;

export const routeKey = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;

export const ROUTE_POLICY: PolicyRegistry = {
  'GET /api/health': { policy: 'PUBLIK' },
  'GET /api/auth/status': { policy: 'PUBLIK' },
  'POST /api/auth/setup-admin': { policy: 'PUBLIK' },
  'POST /api/auth/login': { policy: 'PUBLIK' },
  'POST /api/auth/logout': { policy: 'PUBLIK' },
  'POST /api/auth/change-password': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/auth/me': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/auth/invites': { policy: 'SISTEM-ADMIN' },
  'GET /api/auth/invites': { policy: 'SISTEM-ADMIN' },
  'POST /api/auth/invites/revoke': { policy: 'SISTEM-ADMIN' },
  'GET /api/auth/members': { policy: 'SISTEM-ADMIN' },
  'PATCH /api/auth/members/:id': { policy: 'SISTEM-ADMIN' },
  'DELETE /api/auth/members/:id': { policy: 'SISTEM-ADMIN' },
  'GET /api/auth/invites/peek': { policy: 'PUBLIK' },
  'POST /api/auth/invites/accept': { policy: 'PUBLIK' },
  'GET /api/publish/status': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/publish/preview/:storyId': { policy: 'PENGGUNA-PEMILIK', resource: 'story:storyId' },
  'POST /api/publish/:platform/connect': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/publish/:platform/callback': { policy: 'PUBLIK', resource: 'oauth-state' },
  'POST /api/publish/:platform/publish': { policy: 'PENGGUNA-PEMILIK', resource: 'story:body.storyId' },
  'POST /api/publish/:platform/disconnect': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/generate/accounts': { policy: 'SISTEM-ADMIN' },
  'POST /api/generate/accounts/remove': { policy: 'SISTEM-ADMIN' },
  'GET /api/generate/status': { policy: 'PENGGUNA-BERSAMA' },
  'GET /api/generate/models': { policy: 'PENGGUNA-BERSAMA' },
  'GET /api/generate/files/:kind/:name': { policy: 'PENGGUNA-PEMILIK', resource: 'genfile' },
  'POST /api/generate/text': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/generate/tts': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/generate/image': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/generate/clip': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/flow/accounts': { policy: 'SISTEM-ADMIN' },
  'POST /api/flow/accounts': { policy: 'SISTEM-ADMIN' },
  'DELETE /api/flow/accounts/:id': { policy: 'SISTEM-ADMIN' },
  'PATCH /api/flow/accounts/:id': { policy: 'SISTEM-ADMIN' },
  'GET /api/flow/pool': { policy: 'SISTEM-ADMIN' },
  'PUT /api/flow/pool': { policy: 'SISTEM-ADMIN' },
  'GET /api/flow/usage': { policy: 'SISTEM-ADMIN' },
  'GET /api/flow/jobs': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/flow/jobs': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/flow/jobs/:id/file': { policy: 'PENGGUNA-PEMILIK', resource: 'flowjob:id' },
  'POST /api/flow/bridge/claim': { policy: 'BRIDGE-TOKEN' },
  'GET /api/flow/bridge/jobs/:id/start-image': { policy: 'BRIDGE-TOKEN' },
  'POST /api/flow/bridge/jobs/:id/complete': { policy: 'BRIDGE-TOKEN' },
  'POST /api/flow/bridge/jobs/:id/fail': { policy: 'BRIDGE-TOKEN' },
  'POST /api/flow/bridge/heartbeat': { policy: 'BRIDGE-TOKEN' },
  'GET /api/providers': { policy: 'SISTEM-ADMIN' },
  'PUT /api/providers/axcel': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/axcel/test': { policy: 'SISTEM-ADMIN' },
  'GET /api/providers/axcel/models': { policy: 'SISTEM-ADMIN' },
  'PUT /api/providers/openrouter': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/openrouter/test': { policy: 'SISTEM-ADMIN' },
  'GET /api/providers/openrouter/models': { policy: 'SISTEM-ADMIN' },
  'GET /api/providers/text': { policy: 'SISTEM-ADMIN' },
  'PUT /api/providers/text': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/text/test': { policy: 'SISTEM-ADMIN' },
  'GET /api/quota': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/providers/keypool': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/keypool/:provider': { policy: 'SISTEM-ADMIN' },
  'DELETE /api/providers/keypool/:provider/:id': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/keypool/:provider/:id/test': { policy: 'SISTEM-ADMIN' },
  // wave 2 (quota): numbers and key activation only, never project content
  'PUT /api/providers/keypool/elevenlabs/active': { policy: 'SISTEM-ADMIN' },
  'POST /api/providers/keypool/:provider/:id/activate': { policy: 'SISTEM-ADMIN' },
  'GET /api/quota/limits/:userId': { policy: 'SISTEM-ADMIN' },
  'PUT /api/quota/limits/:userId': { policy: 'SISTEM-ADMIN' },
  'GET /api/quota/usage': { policy: 'SISTEM-ADMIN' },
  'GET /api/providers/text-routing': { policy: 'SISTEM-ADMIN' },
  'PUT /api/providers/text-routing': { policy: 'SISTEM-ADMIN' },
  'GET /api/dub/voices': { policy: 'PENGGUNA-BERSAMA' },
  'GET /api/stories/:id/dub': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'PUT /api/stories/:id/dub/settings': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'PUT /api/stories/:id/dub/shots/:shotId': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'DELETE /api/stories/:id/dub/shots/:shotId': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/dub/plan': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/dub/render': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/dub/cancel': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/dub/shots/:shotId/audio': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/system/load': { policy: 'SISTEM-ADMIN' },
  'GET /api/stories': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/stories': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/stories/catalog': { policy: 'PENGGUNA-BERSAMA' },
  'GET /api/stories/templates/:id/cover': { policy: 'PENGGUNA-BERSAMA' },
  'POST /api/stories/templates/:id/cover': { policy: 'SISTEM-ADMIN' },
  'POST /api/stories/draft': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/stories/:id': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'PUT /api/stories/:id': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/compile-shot': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/render': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/prepare': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/assemble': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/look': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/shots/:shotId/frame': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/shots/:shotId/frame': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/shots/:shotId/repair': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/shots/:shotId/approve-audit': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/cast/:token/image': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/scenes/:sceneId/breakdown': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/cast/:token/sheet': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/uploads': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/music': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/music': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/uploads/:file': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/retry': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'DELETE /api/stories/:id': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/video': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/video/poster': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/shots/:shotId/poster': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/shots/:shotId/video': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'GET /api/stories/:id/assistant': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/assistant': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /api/stories/:id/assistant/undo/:undoId': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
  'POST /mcp': { policy: 'MCP-TOKEN', resource: 'token' },
  'GET /mcp': { policy: 'PUBLIK' },
  'DELETE /mcp': { policy: 'PUBLIK' },
  'GET /api/mcp/tokens': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/mcp/tokens': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'DELETE /api/mcp/tokens/:id': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'POST /api/mcp/test': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/trends': { policy: 'PENGGUNA-BERSAMA' },
  'POST /api/trends/:id/clone': { policy: 'PENGGUNA-PEMILIK', resource: 'self' },
  'GET /api/storage': { policy: 'SISTEM-ADMIN' },
  'POST /api/storage/cleanup': { policy: 'SISTEM-ADMIN' },
  'GET /index.html': { policy: 'PUBLIK' },
  'GET /assets/*': { policy: 'PUBLIK' },
  'GET /api/auth/client-ip': { policy: 'SISTEM-ADMIN' },
  'POST /api/flow/jobs/:id/cancel': { policy: 'PENGGUNA-PEMILIK', resource: 'flowjob:id' },
  // T4 jobs: queue load without content, and the D7 emergency stop of a stuck QUEUED job (logged).
  'GET /api/admin/flow/jobs': { policy: 'SISTEM-ADMIN' },
  'POST /api/admin/flow/jobs/:id/cancel': { policy: 'SISTEM-ADMIN' },
  'POST /api/stories/:id/motion-check': { policy: 'PENGGUNA-PEMILIK', resource: 'story:id' },
};

export type PolicyFinding = { key: string; policy: string; status: number };
export type PolicyGuardOptions = {
  /** Replaces ROUTE_POLICY (tests). */
  registry?: PolicyRegistry;
  /** Report-only: gets a finding when a route that needs a login answered 2xx/3xx to a request carrying no credentials at all. Default: a warning in the log. */
  report?: (finding: PolicyFinding) => void;
};

const NEEDS_LOGIN: ReadonlySet<Policy> = new Set(['PENGGUNA-PEMILIK', 'PENGGUNA-BERSAMA', 'SISTEM-ADMIN']);

/** Routes of `@fastify/static` carry the file they serve (`config.file` + `config.rootPath`): the SPA files are public by nature. */
const isStaticFile = (config: unknown): boolean => {
  const c = config as { file?: unknown; rootPath?: unknown } | undefined;
  return typeof c?.file === 'string' && typeof c?.rootPath === 'string';
};

const hasCredentials = (request: FastifyRequest): boolean =>
  Boolean(request.headers.authorization) || (request.headers.cookie ?? '').includes(`${SESSION_COOKIE}=`);

/**
 * Fail-closed boot guard + report-only behaviour check. Install it FIRST on the root instance, before any route.
 *  - `onRoute`: a route (HEAD/OPTIONS twins aside) with no registry entry and no `config.policy` throws
 *    `Rute tanpa kebijakan: <METHOD> <url>`, so the server does not boot.
 *  - `onResponse`: report-only, never changes a response.
 */
export function installPolicyGuard(server: FastifyInstance, options: PolicyGuardOptions = {}): void {
  const registry = options.registry ?? ROUTE_POLICY;
  server.addHook('onRoute', route => {
    const config = route.config as { policy?: Policy } | undefined;
    if (config?.policy || isStaticFile(route.config)) return;
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      if (!registry[routeKey(method, route.url)]) throw new Error(`Rute tanpa kebijakan: ${routeKey(method, route.url)}`);
    }
  });
  server.addHook('onResponse', async (request, reply) => {
    try {
      const config = request.routeOptions.config as { policy?: Policy } | undefined;
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const key = routeKey(method, request.routeOptions.url ?? '');
      const policy = config?.policy ?? registry[key]?.policy;
      if (!policy || !NEEDS_LOGIN.has(policy) || reply.statusCode >= 400 || hasCredentials(request)) return;
      const finding = { key, policy, status: reply.statusCode };
      if (options.report) options.report(finding);
      else request.log.warn({ tenancy: finding }, 'rute berkebijakan login menjawab tanpa kredensial');
    } catch { /* report-only: never disturbs a response */ }
  });
}

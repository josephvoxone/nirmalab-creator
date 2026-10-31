import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { FlowStore } from '../flow/store.js';
import type { StoryService } from '../stories/service.js';
import { ROUTE_POLICY, isStaticFile, routeKey, type Policy, type PolicyRegistry, type Resource, type RoutePolicy } from './policy.js';

/**
 * T3 — the ownership gate (audit 06 §A.4 layer 2): ONE global hook that enforces the route-policy registry on every request,
 * before the body is read (an 11 MB upload by someone who does not own the project ends in 404 without a byte parsed).
 *
 *   PUBLIK / BRIDGE-TOKEN / MCP-TOKEN   pass (the bridge and MCP verify their own token where they always did)
 *   PENGGUNA-BERSAMA                    a login
 *   SISTEM-ADMIN                        a login, and an admin (403 otherwise)
 *   PENGGUNA-PEMILIK + resource         a login, and the caller OWNS the project / job the route names. Anyone else — admin included —
 *                                       gets the SAME 404 as for an id that does not exist (no oracle), and so does a project with no owner.
 *   PENGGUNA-PEMILIK + self / genfile   a login (the handler scopes to the caller; generated files belong to area jobs)
 *
 * The role of the caller is NOT a key to a project any more: an admin has no access to a project he does not own.
 * Registered right after CSRF and before any route, so every scope created later inherits it.
 */

export const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } } as const;
export const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: 'Admin only' } } as const;
export const STORY_NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'Story not found' } } as const;
export const JOB_NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'Job not found' } } as const;

export type OwnershipDeps = {
  auth: UserAuthStore;
  /** Lazy: the gate is installed before the services exist (hooks must be on the root before any scope is registered). */
  stories: () => StoryService;
  flow: () => FlowStore;
  /** The account that owned everything before ownership was recorded: it keeps the Flow jobs that carry no owner at all. */
  legacyOwnerId?: () => string | undefined;
  registry?: PolicyRegistry;
};

type Kind = 'story' | 'job';
type Target = { kind: Kind; id: unknown };

/** What a route names, from its params (or, for the one route that names it in the body, from the parsed body). */
function target(resource: Resource | undefined, request: FastifyRequest, phase: 'params' | 'body'): Target | undefined {
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (phase === 'params') {
    if (resource === 'story:id') return { kind: 'story', id: params.id };
    if (resource === 'story:storyId') return { kind: 'story', id: params.storyId };
    if (resource === 'flowjob:id') return { kind: 'job', id: params.id };
    return undefined;
  }
  if (resource === 'story:body.storyId') {
    const body = request.body as { storyId?: unknown } | undefined | null;
    // Absent or malformed: nothing to protect, the handler answers its own 400.
    return typeof body?.storyId === 'string' && body.storyId ? { kind: 'story', id: body.storyId } : undefined;
  }
  return undefined;
}

export function installOwnershipGate(server: FastifyInstance, deps: OwnershipDeps): void {
  const registry = deps.registry ?? ROUTE_POLICY;

  const entryOf = (request: FastifyRequest): RoutePolicy | undefined => {
    const config = request.routeOptions.config as { policy?: Policy } | undefined;
    if (isStaticFile(config)) return { policy: 'PUBLIK' };
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const entry = registry[routeKey(method, request.routeOptions.url ?? '')];
    if (config?.policy) return { ...entry, policy: config.policy };
    return entry;
  };

  /** The user that owns the project / job, or undefined (no such thing, or nobody owns it). */
  const ownerOf = async ({ kind, id }: Target): Promise<string | undefined> => {
    if (typeof id !== 'string' || !id) return undefined;
    if (kind === 'story') return deps.stories().ownerOf(id);
    const job = await deps.flow().getJob(id).catch(() => undefined);
    if (!job) return undefined;
    if (job.createdBy) return job.createdBy;
    // A project job the owner never stamped: whoever owns its project; a job with neither: the account that owned everything before.
    if (job.group) { const viaGroup = await deps.stories().ownerOf(job.group); if (viaGroup) return viaGroup; }
    return deps.legacyOwnerId?.();
  };

  const denied = (reply: FastifyReply, kind: Kind) => reply.code(404).send(kind === 'story' ? STORY_NOT_FOUND_BODY : JOB_NOT_FOUND_BODY);

  server.addHook('onRequest', async (request, reply) => {
    const entry = entryOf(request);
    // No entry = not a registered route (the not-found handler, which serves the SPA or a JSON 404): nothing to enforce.
    if (!entry || entry.policy === 'PUBLIK' || entry.policy === 'BRIDGE-TOKEN' || entry.policy === 'MCP-TOKEN') return undefined;
    const user = sessionUser(deps.auth, request);
    if (!user) return reply.code(401).send(UNAUTHORIZED_BODY);
    if (entry.policy === 'SISTEM-ADMIN') return user.isAdmin ? undefined : reply.code(403).send(FORBIDDEN_BODY);
    if (entry.policy !== 'PENGGUNA-PEMILIK') return undefined;
    const named = target(entry.resource, request, 'params');
    if (!named) return undefined;
    return (await ownerOf(named)) === user.id ? undefined : denied(reply, named.kind);
  });

  // The one route that names its project in the JSON body (publish): the body is small, so it is checked once parsed, before the handler.
  server.addHook('preHandler', async (request, reply) => {
    const entry = entryOf(request);
    if (!entry || entry.policy !== 'PENGGUNA-PEMILIK' || entry.resource !== 'story:body.storyId') return undefined;
    const user = sessionUser(deps.auth, request);
    if (!user) return reply.code(401).send(UNAUTHORIZED_BODY);
    const named = target(entry.resource, request, 'body');
    if (!named) return undefined;
    return (await ownerOf(named)) === user.id ? undefined : denied(reply, named.kind);
  });
}

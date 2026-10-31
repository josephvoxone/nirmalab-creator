/**
 * Second CSRF layer (the first is SameSite=Lax). A state-changing request that carries the session cookie and
 * announces a foreign source is refused before any route runs:
 *   - `Origin` present and its host is not this app's host (nor in ALLOWED_ORIGINS), or is `null`/malformed;
 *   - `Sec-Fetch-Site` is `cross-site` or `same-site` (a sibling subdomain of the same registrable domain
 *     still sends the cookie, and SameSite does not stop it).
 * No `Origin` and no `Sec-Fetch-Site` = not a browser (curl, scripts) and passes; requests without the session
 * cookie (MCP Bearer, Flow bridge token, anonymous login) are never inspected.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from './routes.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const COOKIE = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`);

function hostOf(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** `ALLOWED_ORIGINS="http://localhost:5173, https://studio.example.com"` → set of hosts. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const host = hostOf(part.trim());
    if (host) hosts.add(host);
  }
  return hosts;
}

export function crossSiteReason(request: FastifyRequest, allowed: Set<string>): string | undefined {
  if (!MUTATING.has(request.method)) return undefined;
  if (!COOKIE.test(request.headers.cookie ?? '')) return undefined;
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return `Sec-Fetch-Site: ${site}`;
  const origin = request.headers.origin;
  if (origin === undefined) return undefined;
  const host = typeof origin === 'string' ? hostOf(origin) : undefined;
  if (!host) return 'Origin tidak valid';
  const own = [request.host, request.headers.host].filter((h): h is string => typeof h === 'string').map(h => h.toLowerCase());
  if (own.includes(host) || allowed.has(host)) return undefined;
  return `Origin ${host}`;
}

export function registerCrossSiteGuard(server: FastifyInstance, allowedOrigins?: string): void {
  const allowed = parseAllowedOrigins(allowedOrigins);
  server.addHook('onRequest', async (request, reply) => {
    if (!crossSiteReason(request, allowed)) return undefined;
    return reply.code(403).send({ error: { code: 'CROSS_SITE', message: 'Permintaan dari situs lain ditolak' } });
  });
}

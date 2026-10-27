/**
 * MCP routes:
 * - `POST /mcp` (+ 405 on GET/DELETE): see server.ts — bearer token only.
 * - Token management, admin session only (requireAdmin, like every story route):
 *   `GET /api/mcp/tokens` → `[{id, name, createdAt, lastUsedAt}]` (the current user's own tokens)
 *   `POST /api/mcp/tokens {name}` → 201 `{id, name, token}` — the only time the plaintext is sent
 *   `DELETE /api/mcp/tokens/:id` → `{ok: true}`; 404 for an unknown id or another user's token
 *   `POST /api/mcp/test {token?}` → `{ok: true, tools, user}`: runs tools/list in-process through
 *   an SDK client over an in-memory transport, as the token's owner (or the session user).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { createMcpServer, registerMcpEndpoint, type McpCaller, type McpDeps } from './server.js';
import { McpTokenError, McpTokenStore } from './tokens.js';

const send = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

/** tools/list through a real SDK client, in-process. */
export async function testConnection(deps: McpDeps, caller: McpCaller): Promise<number> {
  const mcp = createMcpServer(deps, caller);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nirmalab-tes-koneksi', version: '1.0.0' });
  try {
    await mcp.connect(serverSide);
    await client.connect(clientSide);
    return (await client.listTools()).tools.length;
  } finally {
    await client.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
}

export async function registerMcpRoutes(
  server: FastifyInstance,
  options: Omit<McpDeps, 'tokens'> & { userAuthStore: UserAuthStore; dataDir: string; tokens?: McpTokenStore }
): Promise<McpTokenStore> {
  const { userAuthStore: auth, dataDir, ...rest } = options;
  const tokens = options.tokens ?? new McpTokenStore(dataDir, auth);
  const deps: McpDeps = { ...rest, tokens };
  registerMcpEndpoint(server, deps);

  server.get('/api/mcp/tokens', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    return tokens.list(user.id);
  });

  server.post<{ Body: { name?: unknown } | undefined }>('/api/mcp/tokens', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    try {
      return reply.code(201).send(await tokens.create(user.id, request.body?.name));
    } catch (error) {
      if (error instanceof McpTokenError) return send(reply, error.code === 'LIMIT' ? 409 : 400, error.code, error.message);
      throw error;
    }
  });

  server.delete<{ Params: { id: string } }>('/api/mcp/tokens/:id', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    if (!(await tokens.revoke(user.id, request.params.id))) return send(reply, 404, 'NOT_FOUND', 'Token tidak ditemukan');
    return { ok: true };
  });

  server.post<{ Body: { token?: unknown } | undefined }>('/api/mcp/test', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    const given = request.body?.token;
    let caller: McpCaller = { userId: user.id, email: user.email, by: 'Tes koneksi' };
    if (given !== undefined && given !== null && given !== '') {
      const verified = await tokens.verify(given);
      if (!verified) return send(reply, 400, 'INVALID_TOKEN', 'Token tidak dikenal, sudah dicabut, atau pemiliknya bukan admin lagi');
      caller = { userId: verified.user.id, email: verified.user.email, by: verified.token.name };
    }
    try {
      return { ok: true, tools: await testConnection(deps, caller), user: caller.email };
    } catch (error) {
      request.log.warn({ err: error }, 'mcp test failed');
      return send(reply, 503, 'FAILED', 'Server MCP tidak menjawab — coba lagi');
    }
  });

  return tokens;
}

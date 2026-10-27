import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { LlmError, type TextModel } from '../src/llm/opencode.js';
import { MAX_TOKENS_PER_USER, McpTokenStore, TOKEN_PATTERN } from '../src/mcp/tokens.js';
import { STALE_REV_MESSAGE, RATE_LIMIT_MESSAGE } from '../src/mcp/server.js';
import type { Storyboard } from '../src/stories/storyboard.js';
import { bibleBoard } from './bible-board.js';

// ------------------------------------------------------------------ fixtures

const draftBoard = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
};

/** No network: the text model is never configured here. */
const offlineModel: TextModel = {
  configured: async () => false,
  chat: async () => { throw new LlmError('NOT_CONFIGURED', 'no key'); }
};

type Setup = Awaited<ReturnType<typeof setup>>;
const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
});

let seq = 0;
async function login(server: FastifyInstance, email: string, password: string) {
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

async function setup(opts: { listen?: boolean; board?: Storyboard } = {}) {
  // A fresh admin email per app: login attempts are rate-limited per ip+email across the process.
  const email = `mcp-admin${++seq}@x.io`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-mcp-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, generateText: async () => JSON.stringify(draftBoard) },
    providers: { workerMs: 0 },
    media: { cleanupMs: 0 },
    text: { model: offlineModel }
  });
  open.push(server);
  const cookie = await login(server, email, 'admin-pass-1');
  const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: opts.board ?? bibleBoard() } })).json().story.id as string;
  const users = new UserAuthStore(dataDir);
  const adminId = users.findUserByEmail(email)!.id;
  let base = '';
  if (opts.listen !== false) {
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  }
  const createToken = async (name = 'Claude Code', c = cookie) => {
    const res = await server.inject({ method: 'POST', url: '/api/mcp/tokens', headers: { cookie: c }, payload: { name } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; name: string; token: string };
  };
  /** A second admin with its own session. */
  const secondAdmin = async () => {
    const other = `mcp-other${++seq}@x.io`;
    const user = await users.createUser({ email: other, password: 'other-pass-1', isAdmin: true });
    return { user, cookie: await login(server, other, 'other-pass-1') };
  };
  return {
    server, dataDir, email, cookie, id, users, adminId, base, createToken, secondAdmin,
    flow: new FlowStore(join(dataDir, 'flow')),
    boardFile: join(dataDir, 'stories', id, 'storyboard.json'),
    history: async () => (await server.inject({ url: `/api/stories/${id}/assistant`, headers: { cookie } })).json().turns as Array<Record<string, any>>
  };
}

async function connect(s: Setup, token?: string) {
  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
    requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} }
  });
  open.push(client);
  await client.connect(transport);
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as CallResult;
  const text = res.content[0]!.text;
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: res.isError === true, text, json };
}

const rpc = (s: Setup, token: string | undefined, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) => fetch(`${s.base}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  },
  body: JSON.stringify(body)
});

// ------------------------------------------------------------------ token routes

describe('MCP token routes', () => {
  it('create shows the token once; list hides it; the file is 0600 with only a sha256', async () => {
    const s = await setup({ listen: false });
    const created = await s.createToken('Laptop kantor');
    expect(created.name).toBe('Laptop kantor');
    expect(created.token).toMatch(TOKEN_PATTERN);
    expect(created.token).toMatch(/^nc_[A-Za-z0-9]{32}$/);

    const list = await s.server.inject({ url: '/api/mcp/tokens', headers: { cookie: s.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ id: created.id, name: 'Laptop kantor', createdAt: expect.any(String), lastUsedAt: null }]);
    expect(list.body).not.toContain(created.token);
    expect(list.body).not.toContain('sha256');

    const file = join(s.dataDir, 'mcp', 'tokens.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(created.token);
    expect(raw).not.toContain(created.token.slice(3));
    const stored = JSON.parse(raw).tokens as Array<Record<string, unknown>>;
    expect(stored).toEqual([{
      id: created.id, userId: s.adminId, name: 'Laptop kantor',
      sha256: createHash('sha256').update(created.token).digest('hex'), createdAt: expect.any(String), lastUsedAt: null
    }]);
  });

  it('name is required (1–40 chars); 10 tokens per user at most', async () => {
    const s = await setup({ listen: false });
    for (const name of ['', '   ', 'x'.repeat(41)]) {
      const res = await s.server.inject({ method: 'POST', url: '/api/mcp/tokens', headers: { cookie: s.cookie }, payload: { name } });
      expect(res.statusCode, name).toBe(400);
    }
    expect((await s.server.inject({ method: 'POST', url: '/api/mcp/tokens', headers: { cookie: s.cookie }, payload: {} })).statusCode).toBe(400);
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) await s.createToken(`t${i}`);
    expect(MAX_TOKENS_PER_USER).toBe(10);
    const over = await s.server.inject({ method: 'POST', url: '/api/mcp/tokens', headers: { cookie: s.cookie }, payload: { name: 'satu lagi' } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toMatch(/10/);
  });

  it('delete own tokens only (another admin\'s id is 404); 401/403 without an admin session', async () => {
    const s = await setup({ listen: false });
    const mine = await s.createToken('punyaku');
    const other = await s.secondAdmin();
    const theirs = await s.createToken('punya dia', other.cookie);

    // Each admin lists only their own.
    expect((await s.server.inject({ url: '/api/mcp/tokens', headers: { cookie: other.cookie } })).json().map((t: { id: string }) => t.id)).toEqual([theirs.id]);

    const cross = await s.server.inject({ method: 'DELETE', url: `/api/mcp/tokens/${theirs.id}`, headers: { cookie: s.cookie } });
    expect(cross.statusCode).toBe(404);
    expect((await s.server.inject({ url: '/api/mcp/tokens', headers: { cookie: other.cookie } })).json()).toHaveLength(1);
    expect((await s.server.inject({ method: 'DELETE', url: '/api/mcp/tokens/tok_nope', headers: { cookie: s.cookie } })).statusCode).toBe(404);

    const del = await s.server.inject({ method: 'DELETE', url: `/api/mcp/tokens/${mine.id}`, headers: { cookie: s.cookie } });
    expect(del.statusCode).toBe(200);
    expect((await s.server.inject({ url: '/api/mcp/tokens', headers: { cookie: s.cookie } })).json()).toEqual([]);

    for (const [method, url] of [['GET', '/api/mcp/tokens'], ['POST', '/api/mcp/tokens'], ['DELETE', `/api/mcp/tokens/${theirs.id}`], ['POST', '/api/mcp/test']] as const) {
      expect((await s.server.inject({ method, url, payload: method === 'POST' ? { name: 'x' } : undefined })).statusCode, url).toBe(401);
    }
    const member = `mcp-member${++seq}@x.io`;
    await s.users.createUser({ email: member, password: 'member-pass-1', isAdmin: false });
    const memberCookie = await login(s.server, member, 'member-pass-1');
    expect((await s.server.inject({ method: 'POST', url: '/api/mcp/tokens', headers: { cookie: memberCookie }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await s.server.inject({ url: '/api/mcp/tokens', headers: { cookie: memberCookie } })).statusCode).toBe(403);
  });

  it('POST /api/mcp/test lists the tools in-process, with the session or a token', async () => {
    const s = await setup({ listen: false });
    const bySession = await s.server.inject({ method: 'POST', url: '/api/mcp/test', headers: { cookie: s.cookie }, payload: {} });
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(bySession.json()).toEqual({ ok: true, tools: expect.any(Number), user: s.email });
    expect(bySession.json().tools).toBeGreaterThanOrEqual(22);

    const other = await s.secondAdmin();
    const { token } = await s.createToken('punya dia', other.cookie);
    const byToken = await s.server.inject({ method: 'POST', url: '/api/mcp/test', headers: { cookie: s.cookie }, payload: { token } });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json()).toEqual({ ok: true, tools: bySession.json().tools, user: other.user.email });

    const bad = await s.server.inject({ method: 'POST', url: '/api/mcp/test', headers: { cookie: s.cookie }, payload: { token: `nc_${'A'.repeat(32)}` } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('nc_');
  });

  it('lastUsedAt is written at most once per minute per token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-mcp-tok-'));
    const users = new UserAuthStore(dataDir);
    const admin = await users.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    let now = Date.parse('2026-10-27T01:00:00Z');
    const store = new McpTokenStore(dataDir, users, { now: () => now });
    const { token, id } = await store.create(admin.id, 'tes');
    const lastUsed = async () => (await store.list(admin.id)).find(t => t.id === id)!.lastUsedAt;
    expect(await store.verify(token)).toMatchObject({ user: { id: admin.id }, token: { id, name: 'tes' } });
    expect(await lastUsed()).toBe('2026-10-27T01:00:00.000Z');
    now += 30_000;
    await store.verify(token);
    expect(await lastUsed()).toBe('2026-10-27T01:00:00.000Z');
    now += 31_000;
    await store.verify(token);
    expect(await lastUsed()).toBe('2026-10-27T01:01:01.000Z');
    expect(await store.verify(`nc_${'b'.repeat(32)}`)).toBeUndefined();
    expect(await store.verify('Bearer nonsense')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ /mcp

describe('/mcp (Streamable HTTP, bearer token)', () => {
  it('no or bad token → 401 JSON-RPC error; the SDK client cannot connect', async () => {
    const s = await setup();
    // A real token on file: an unknown token must still be refused (the hash is compared, not just the shape).
    const real = await s.createToken('asli');
    for (const token of [undefined, 'nonsense', `nc_${'Z'.repeat(32)}`, `${real.token.slice(0, -1)}${real.token.endsWith('a') ? 'b' : 'a'}`]) {
      const res = await rpc(s, token);
      expect(res.status, String(token)).toBe(401);
      const body = await res.json() as { jsonrpc: string; error: { message: string } };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.message).toMatch(/Unauthorized/);
    }
    await expect(connect(s)).rejects.toThrow();
    await expect(connect(s, `nc_${'Z'.repeat(32)}`)).rejects.toThrow();
  });

  it('GET and DELETE /mcp answer 405 (stateless server)', async () => {
    const s = await setup();
    const { token } = await s.createToken();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${s.base}/mcp`, { method, headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
      expect(res.status, method).toBe(405);
      expect((await res.json() as { error: { code: number } }).error.code).toBe(-32000);
    }
  });

  it('tools/list: every action plus list_projects/create_project; project_id required everywhere else; confirm only on spending tools', async () => {
    const s = await setup();
    const { token } = await s.createToken();
    const client = await connect(s, token);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const n of ['edit_shot', 'list_projects', 'create_project', 'get_project', 'render', 'undo_last', 'breakdown_scene']) expect(names).toContain(n);
    expect(tools.length).toBeGreaterThanOrEqual(22);
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
      if (tool.name === 'list_projects' || tool.name === 'create_project') {
        expect(schema.properties?.project_id, tool.name).toBeUndefined();
        continue;
      }
      expect(schema.required, tool.name).toContain('project_id');
      expect(schema.properties?.project_id?.type, tool.name).toBe('string');
    }
    const render = tools.find(t => t.name === 'render')!;
    const props = (render.inputSchema as { properties: Record<string, { type: string }> }).properties;
    expect(props.confirm!.type).toBe('boolean');
    expect(props.rev!.type).toBe('integer');
    expect(render.description).toMatch(/without confirm/i);
    expect(render.description).toMatch(/confirm: ?true/);
    expect((tools.find(t => t.name === 'edit_shot')!.inputSchema as { properties: Record<string, unknown> }).properties.confirm).toBeUndefined();
    expect(client.getInstructions()).toMatch(/shot/i);
    expect(client.getInstructions()).toMatch(/confirm/);
  });

  it('list_projects and create_project (the app\'s draft path)', async () => {
    const s = await setup();
    const { token } = await s.createToken();
    const client = await connect(s, token);
    const listed = await call(client, 'list_projects', {});
    expect(listed.isError).toBe(false);
    expect(listed.json).toEqual([{ project_id: s.id, title: 'Pasar Pagi', status: expect.any(String), shots: 2, updatedAt: expect.any(String) }]);

    const created = await call(client, 'create_project', { premise: 'Seekor kucing hilang di kampung', aspect: '16:9' });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toEqual({ project_id: expect.any(String), title: 'Kucing Hilang' });
    const story = await s.server.inject({ url: `/api/stories/${created.json.project_id}`, headers: { cookie: s.cookie } });
    expect(story.statusCode).toBe(200);
    expect(story.json().storyboard.aspect).toBe('16:9');
    expect(story.json().story.createdBy).toBe(s.adminId);

    const short = await call(client, 'create_project', { premise: 'ab' });
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/premis/i);
    const badTemplate = await call(client, 'create_project', { premise: 'Seekor kucing hilang', template: 'tidak-ada' });
    expect(badTemplate.isError).toBe(true);
    expect((await call(client, 'list_projects', {})).json).toHaveLength(2);
  });

  it('edit_shot changes the story and logs an MCP turn with the token name and Batalkan; get_project is not logged', async () => {
    const s = await setup();
    const { token } = await s.createToken('Claude Code');
    const client = await connect(s, token);
    const before = JSON.parse(readFileSync(s.boardFile, 'utf8')) as Storyboard;

    const read = await call(client, 'get_project', { project_id: s.id });
    expect(read.isError).toBe(false);
    expect(read.json.data.shots).toHaveLength(2);
    expect(read.text).not.toContain(s.dataDir);
    expect(await s.history()).toEqual([]);

    const edit = await call(client, 'edit_shot', { project_id: s.id, shot: 2, emotion: 'lega' });
    expect(edit.isError, edit.text).toBe(false);
    expect(edit.json).toMatchObject({ ok: true, changed: true, label: expect.any(String) });
    expect(edit.text).not.toContain(s.dataDir);
    const after = JSON.parse(readFileSync(s.boardFile, 'utf8')) as Storyboard;
    expect(after.shots[1]!.intent!.emotion).toBe('lega');
    expect(after.shots[0]).toEqual(before.shots[0]);

    const turns = await s.history();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'assistant', source: 'mcp', by: 'Claude Code', text: edit.json.label, changes: [{ label: edit.json.label, undoId: expect.any(String) }] });

    // The chip undoes it (same route the chat uses).
    const undo = await s.server.inject({ method: 'POST', url: `/api/stories/${s.id}/assistant/undo/${turns[0]!.changes[0].undoId}`, headers: { cookie: s.cookie }, payload: {} });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((JSON.parse(readFileSync(s.boardFile, 'utf8')) as Storyboard).shots[1]!.intent!.emotion).toBe(before.shots[1]!.intent!.emotion);

    // Errors: plain message, isError, nothing logged.
    const missing = await call(client, 'edit_shot', { project_id: s.id, shot: 99, emotion: 'x' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('Shot 99 tidak ada. Shot yang ada: 1–2.');
    expect(await call(client, 'edit_shot', { project_id: 'nope', shot: 1, emotion: 'x' })).toMatchObject({ isError: true });
    expect(await call(client, 'edit_shot', { shot: 1, emotion: 'x' })).toMatchObject({ isError: true });
    expect(await call(client, 'nope_tool', { project_id: s.id })).toMatchObject({ isError: true });
    expect(await s.history()).toHaveLength(1);
  });

  it('render without confirm → needsConfirm + rev and no job; confirm:true + rev queues; a stale rev is refused', async () => {
    const s = await setup();
    const { token } = await s.createToken('Cursor');
    const client = await connect(s, token);

    const ask = await call(client, 'render', { project_id: s.id, scene: 1 });
    expect(ask.isError, ask.text).toBe(false);
    expect(ask.json).toMatchObject({ needsConfirm: true, label: expect.any(String), estimate: { credits: expect.any(Number) }, rev: 1 });
    expect(ask.json.estimate.credits).toBeGreaterThan(0);
    expect(await s.flow.listJobs()).toHaveLength(0);
    // Anything but the boolean true is not a confirmation.
    for (const confirm of ['true', 1, false]) {
      expect((await call(client, 'render', { project_id: s.id, scene: 1, confirm })).json.needsConfirm, String(confirm)).toBe(true);
    }
    expect(await s.flow.listJobs()).toHaveLength(0);
    expect(await s.history()).toEqual([]);

    // A stale rev: the board changed since the cost was shown.
    await call(client, 'edit_shot', { project_id: s.id, shot: 1, emotion: 'lega' });
    const stale = await call(client, 'render', { project_id: s.id, scene: 1, confirm: true, rev: ask.json.rev });
    expect(stale.isError).toBe(true);
    expect(stale.text).toBe(STALE_REV_MESSAGE);
    expect(STALE_REV_MESSAGE).toBe('Proyek sudah berubah — cek biaya lagi');
    expect(await s.flow.listJobs()).toHaveLength(0);

    const again = await call(client, 'render', { project_id: s.id, scene: 1 });
    expect(again.json.rev).toBe(2);
    const go = await call(client, 'render', { project_id: s.id, scene: 1, confirm: true, rev: again.json.rev });
    expect(go.isError, go.text).toBe(false);
    expect(go.json.ok).toBe(true);
    expect((await s.flow.listJobs()).length).toBe(2);
    const turns = await s.history();
    expect(turns.at(-1)).toMatchObject({ role: 'assistant', source: 'mcp', by: 'Cursor', text: go.json.label });
  });

  it('a revoked token, a demoted admin and a removed user are rejected', async () => {
    const s = await setup();
    const mine = await s.createToken('lama');
    const kept = await s.createToken('baru');
    expect((await rpc(s, mine.token)).status).toBe(200);
    await s.server.inject({ method: 'DELETE', url: `/api/mcp/tokens/${mine.id}`, headers: { cookie: s.cookie } });
    expect((await rpc(s, mine.token)).status).toBe(401);
    await expect(connect(s, mine.token)).rejects.toThrow();
    expect((await rpc(s, kept.token)).status).toBe(200);

    const other = await s.secondAdmin();
    const theirs = await s.createToken('punya dia', other.cookie);
    expect((await rpc(s, theirs.token)).status).toBe(200);
    s.users.setAdmin(other.user.id, false, s.adminId);
    expect((await rpc(s, theirs.token)).status).toBe(401);
    s.users.setAdmin(other.user.id, true, s.adminId);
    expect((await rpc(s, theirs.token)).status).toBe(200);
    s.users.removeUser(other.user.id, s.adminId);
    expect((await rpc(s, theirs.token)).status).toBe(401);
  });

  it('resources: the four skills as nirmalab://skills/NAME (markdown)', async () => {
    const s = await setup();
    const { token } = await s.createToken();
    const client = await connect(s, token);
    const { resources } = await client.listResources();
    expect(resources.map(r => r.uri).sort()).toEqual(['cinematic', 'continuity', 'copy', 'hooks'].map(n => `nirmalab://skills/${n}`));
    for (const r of resources) expect(r.mimeType).toBe('text/markdown');
    const copy = await client.readResource({ uri: 'nirmalab://skills/copy' });
    expect((copy.contents[0] as { text: string }).text).toContain('fantastis');
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  it('rate limit: 60 calls per minute per token, the 61st is refused', async () => {
    const s = await setup();
    const { token } = await s.createToken('cepat');
    const other = await s.createToken('lain');
    for (let i = 1; i <= 60; i++) {
      const res = await rpc(s, token, { jsonrpc: '2.0', id: i, method: 'tools/list', params: {} });
      expect(res.status, `call ${i}`).toBe(200);
      await res.arrayBuffer();
    }
    const over = await rpc(s, token, { jsonrpc: '2.0', id: 61, method: 'tools/list', params: {} });
    expect(over.status).toBe(429);
    const body = await over.json() as { jsonrpc: string; id: number; error: { message: string } };
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 61, error: { message: RATE_LIMIT_MESSAGE } });
    expect(RATE_LIMIT_MESSAGE).toBe('Terlalu banyak permintaan');
    // Per token: another token is unaffected.
    expect((await rpc(s, other.token)).status).toBe(200);
  });
});

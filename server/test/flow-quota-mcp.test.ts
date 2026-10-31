import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { writeFileSync, mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { LlmError, type TextModel } from '../src/llm/opencode.js';
import { MAX_TOKENS_PER_USER, McpTokenStore, TOKEN_PATTERN } from '../src/mcp/tokens.js';
import { STALE_REV_MESSAGE, RATE_LIMIT_MESSAGE } from '../src/mcp/server.js';
import type { TextGenerator } from '../src/stories/draft.js';
import { StoryService } from '../src/stories/service.js';
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

async function setup(opts: { listen?: boolean; board?: Storyboard; generateText?: TextGenerator } = {}) {
  // A fresh admin email per app: login attempts are rate-limited per ip+email across the process.
  const email = `mcp-admin${++seq}@x.io`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-mcp-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, generateText: opts.generateText ?? (async () => JSON.stringify(draftBoard)) },
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


describe('T5b quota over MCP (and so the assistant action layer): the same gate, the same Indonesian message', () => {
  it('render with confirm over the limit: isError with the QUOTA message, no job; under the limit it queues', async () => {
    const s = await setup();
    const { token } = await s.createToken('Cursor');
    const client = await connect(s, token);
    const put = await s.server.inject({ method: 'PUT', url: `/api/quota/limits/${s.adminId}`, headers: { cookie: s.cookie }, payload: { limits: { flowCredits: { perDay: 10 } } } });
    expect(put.statusCode, put.body).toBe(200);
    const ask = await call(client, 'render', { project_id: s.id });
    expect(ask.isError, ask.text).toBe(false);
    const refused = await call(client, 'render', { project_id: s.id, confirm: true, rev: ask.json.rev });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Kuota kredit Flow harianmu habis: terpakai 0 dari 10 kredit hari ini; pekerjaan ini butuh \d+\./);
    expect(await s.flow.listJobs()).toHaveLength(0);
    await s.server.inject({ method: 'PUT', url: `/api/quota/limits/${s.adminId}`, headers: { cookie: s.cookie }, payload: { limits: {} } });
    const go = await call(client, 'render', { project_id: s.id, confirm: true, rev: ask.json.rev });
    expect(go.isError, go.text).toBe(false);
    expect((await s.flow.listJobs()).length).toBeGreaterThan(0);
  });
});

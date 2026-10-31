/**
 * T3 cross-user matrix (audit 06 §E.2), GENERATED FROM THE POLICY REGISTRY: every PENGGUNA-PEMILIK route that names a project
 * (or a Flow job) must have a fixture here, and for each one a non-owner — an admin (B) AND a member (M) — gets the same 404 as
 * for a project that does not exist, and NOTHING moves (project tree, Flow jobs, quota ledger, text model, ElevenLabs). The
 * owner (A, the admin who owns Joseph's kind of project) keeps working; so does an owner who is only a member.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { ACTION_NAMES } from '../src/assistant/actions.js';
import { FlowStore } from '../src/flow/store.js';
import type { ChatInput, ChatOutput, TextModel } from '../src/llm/opencode.js';
import { McpTokenStore } from '../src/mcp/tokens.js';
import { StoryService } from '../src/stories/service.js';
import { SnapshotStore } from '../src/stories/snapshots.js';
import { ROUTE_POLICY } from '../src/tenancy/policy.js';
import { createWorkspaceRecord, personalWorkspaceId, setMembership } from '../src/tenancy/workspace-role.js';
import { bibleBoard } from './bible-board.js';
import { makePng } from './media-helpers.js';

// ------------------------------------------------------------------ the world

type Actor = { id: string; email: string; cookie: string };
type World = Awaited<ReturnType<typeof makeWorld>>;
type Project = { id: string; undoId: string; uploadFile: string; dir: string };

const open: FastifyInstance[] = [];
let seq = 0;
const PASS = 'matrix-pass-1';

async function login(server: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

const treeHash = (dir: string): string => {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { h.update(`D:${full}`); walk(full); } else { h.update(`F:${full}:`); h.update(readFileSync(full)); }
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
};

async function makeWorld() {
  const n = ++seq;
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-matrix-'));
  const counters = { chat: 0, eleven: 0, network: 0 };
  const model: TextModel = {
    configured: async () => true,
    chat: async (_input: ChatInput): Promise<ChatOutput> => { counters.chat += 1; return { message: { role: 'assistant', content: 'Selesai.' }, model: 'fake' }; }
  };
  const failFetch = (async () => { counters.network += 1; throw new Error('no network in tests'); }) as typeof fetch;
  const emailA = `matrix-a${n}@x.io`;
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: emailA, OPENCREATOR_ADMIN_PASSWORD: PASS, OPENCREATOR_FLOW_BRIDGE_TOKEN: 'bridge-secret-token-1234567890' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1)); }, generateText: async () => JSON.stringify({ title: 'Dibuat lewat MCP', audio: 'Audio: "{line}"', shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley.' }] }) },
    providers: { workerMs: 0, fetch: failFetch },
    dub: { resume: false, fetch: (async () => { counters.eleven += 1; throw new Error('no ElevenLabs in tests'); }) as typeof fetch },
    media: { cleanupMs: 0 },
    text: { model }
  });
  open.push(server);
  const users = new UserAuthStore(dataDir);
  const mk = async (label: string, isAdmin: boolean): Promise<Actor> => {
    const email = `matrix-${label}${n}@x.io`;
    const user = await users.createUser({ email, password: PASS, isAdmin });
    return { id: user.id, email, cookie: await login(server, email, PASS) };
  };
  const a: Actor = { id: users.findUserByEmail(emailA)!.id, email: emailA, cookie: await login(server, emailA, PASS) };
  const b = await mk('b', true);
  const m = await mk('m', false);
  const am = await mk('am', false);
  const ae = await mk('ae', false);
  const av = await mk('av', false);

  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });

  /** A project of `owner` with every kind of artefact the routes can reach. */
  async function seedProject(owner: Actor): Promise<Project> {
    const record = await service.create(bibleBoard(), { createdBy: owner.id });
    const id = record.id;
    const dir = service.storyDir(id);
    const storyJson = JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
    writeFileSync(join(dir, 'story.json'), JSON.stringify({ ...storyJson, status: 'done', video: { bytes: 64, finishedAtMs: Date.now() } }));
    writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1));
    writeFileSync(join(dir, '01-laras.mp4'), Buffer.alloc(64, 2));
    makePng(join(dir, 'frame-01-laras.png'), 64, 64);
    makePng(join(dir, 'cast-LARAS.png'), 64, 64);
    mkdirSync(join(dir, 'uploads'), { recursive: true });
    const uploadFile = 'up_0123456789abcdef.png';
    makePng(join(dir, 'uploads', uploadFile), 64, 64);
    writeFileSync(join(dir, 'music.mp3'), Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2000, 3)]));
    mkdirSync(join(dir, 'dub'), { recursive: true });
    writeFileSync(join(dir, 'dub', '01-laras-h1.mp3'), Buffer.from('MP3:rahasia'));
    writeFileSync(join(dir, 'dub.json'), JSON.stringify({ version: 1, settings: { voiceId: 'voice_a1' }, shots: { '01-laras': { status: 'done', file: 'dub/01-laras-h1.mp3', text: 'rahasia pemilik' } } }));
    writeFileSync(join(dir, 'assistant.json'), JSON.stringify([{ role: 'user', text: 'rahasia riwayat', at: new Date().toISOString() }]));
    const { undoId } = await new SnapshotStore(join(dataDir, 'stories')).take(id, 'seed');
    return { id, undoId, uploadFile, dir };
  }

  const mine = await seedProject(a);
  // Flow: a Studio job of A (createdBy) with a finished file, and a queued project job (group = A's project).
  // A finished job OF the project (a project job is reached through its workspace; a Studio job stays personal).
  const job = await flow.createJob({ prompt: 'rahasia prompt A', durationSec: 6, createdBy: a.id, group: mine.id });
  await flow.claimJob('mac');
  mkdirSync(join(dataDir, 'flow', 'clips'), { recursive: true });
  const jobFile = join(dataDir, 'flow', 'clips', `${job.id}.mp4`);
  writeFileSync(jobFile, Buffer.alloc(64, 9));
  await flow.completeJob(job.id, { filePath: jobFile, bytes: 64 });
  const queued = await flow.createJob({ prompt: 'antre A', durationSec: 6, createdBy: a.id, group: mine.id });

  const memberOwned = await seedProject(am);
  return { server, dataDir, users, a, b, m, am, ae, av, flow, service, counters, mine, jobId: job.id, queuedJobId: queued.id, memberOwned, seedProject };
}

// ------------------------------------------------------------------ fixtures: one request per registry route

type Req = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; payload?: unknown; headers?: Record<string, string> };
type Ids = { id: string; undoId: string; uploadFile: string; jobId: string; queuedJobId: string };
type Fixture = (p: Ids) => Req;

const SHOT = '01-laras';
const S = (p: Ids, rest = '') => `/api/stories/${p.id}${rest}`;
const FIXTURES: Record<string, Fixture> = {
  'GET /api/publish/preview/:storyId': p => ({ method: 'GET', url: `/api/publish/preview/${p.id}` }),
  'POST /api/publish/:platform/publish': p => ({ method: 'POST', url: '/api/publish/youtube/publish', payload: { storyId: p.id, title: 'x' } }),
  'GET /api/stories/:id/dub': p => ({ method: 'GET', url: S(p, '/dub') }),
  'PUT /api/stories/:id/dub/settings': p => ({ method: 'PUT', url: S(p, '/dub/settings'), payload: { voiceId: 'voice_b_hijack' } }),
  'PUT /api/stories/:id/dub/shots/:shotId': p => ({ method: 'PUT', url: S(p, `/dub/shots/${SHOT}`), payload: { text: 'ditimpa B' } }),
  'DELETE /api/stories/:id/dub/shots/:shotId': p => ({ method: 'DELETE', url: S(p, `/dub/shots/${SHOT}`) }),
  'POST /api/stories/:id/dub/plan': p => ({ method: 'POST', url: S(p, '/dub/plan'), payload: { scope: { kind: 'all' } } }),
  'POST /api/stories/:id/dub/render': p => ({ method: 'POST', url: S(p, '/dub/render'), payload: { scope: { kind: 'all' } } }),
  'POST /api/stories/:id/dub/cancel': p => ({ method: 'POST', url: S(p, '/dub/cancel'), payload: {} }),
  'GET /api/stories/:id/dub/shots/:shotId/audio': p => ({ method: 'GET', url: S(p, `/dub/shots/${SHOT}/audio`) }),
  'GET /api/stories/:id': p => ({ method: 'GET', url: S(p) }),
  'PUT /api/stories/:id': p => ({ method: 'PUT', url: S(p), payload: { storyboard: { ...bibleBoard(), title: 'Ditimpa B' } } }),
  'POST /api/stories/:id/compile-shot': p => ({ method: 'POST', url: S(p, '/compile-shot'), payload: { shot: { id: SHOT, prompt: 'x' } } }),
  'POST /api/stories/:id/render': p => ({ method: 'POST', url: S(p, '/render'), payload: {} }),
  'POST /api/stories/:id/prepare': p => ({ method: 'POST', url: S(p, '/prepare'), payload: {} }),
  'POST /api/stories/:id/assemble': p => ({ method: 'POST', url: S(p, '/assemble'), payload: {} }),
  'POST /api/stories/:id/look': p => ({ method: 'POST', url: S(p, '/look'), payload: { look: { family: 'film-real', variant: 'cinematic-drama' } } }),
  'GET /api/stories/:id/shots/:shotId/frame': p => ({ method: 'GET', url: S(p, `/shots/${SHOT}/frame?w=320`) }),
  'POST /api/stories/:id/shots/:shotId/frame': p => ({ method: 'POST', url: S(p, `/shots/${SHOT}/frame`), payload: {} }),
  'POST /api/stories/:id/shots/:shotId/repair': p => ({ method: 'POST', url: S(p, `/shots/${SHOT}/repair`), payload: {} }),
  'POST /api/stories/:id/shots/:shotId/approve-audit': p => ({ method: 'POST', url: S(p, `/shots/${SHOT}/approve-audit`), payload: {} }),
  'POST /api/stories/:id/motion-check': p => ({ method: 'POST', url: S(p, '/motion-check'), payload: {} }),
  'GET /api/stories/:id/cast/:token/image': p => ({ method: 'GET', url: S(p, '/cast/LARAS/image') }),
  'POST /api/stories/:id/scenes/:sceneId/breakdown': p => ({ method: 'POST', url: S(p, '/scenes/pasar/breakdown'), payload: {} }),
  'POST /api/stories/:id/cast/:token/sheet': p => ({ method: 'POST', url: S(p, '/cast/LARAS/sheet'), payload: {} }),
  'POST /api/stories/:id/uploads': p => ({ method: 'POST', url: S(p, '/uploads'), payload: readFileSync(join(tmpdir(), 'nc-matrix-upload.png')), headers: { 'content-type': 'image/png' } }),
  'POST /api/stories/:id/music': p => ({ method: 'POST', url: S(p, '/music'), payload: Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(500, 5)]), headers: { 'content-type': 'audio/mpeg', 'x-file-name': 'b.mp3' } }),
  'GET /api/stories/:id/music': p => ({ method: 'GET', url: S(p, '/music'), headers: { range: 'bytes=0-10' } }),
  'GET /api/stories/:id/uploads/:file': p => ({ method: 'GET', url: S(p, `/uploads/${p.uploadFile}?w=96`) }),
  'POST /api/stories/:id/retry': p => ({ method: 'POST', url: S(p, '/retry'), payload: {} }),
  'GET /api/stories/:id/video': p => ({ method: 'GET', url: S(p, '/video'), headers: { range: 'bytes=0-10' } }),
  'GET /api/stories/:id/video/poster': p => ({ method: 'GET', url: S(p, '/video/poster') }),
  'GET /api/stories/:id/shots/:shotId/poster': p => ({ method: 'GET', url: S(p, `/shots/${SHOT}/poster`) }),
  'GET /api/stories/:id/shots/:shotId/video': p => ({ method: 'GET', url: S(p, `/shots/${SHOT}/video`), headers: { range: 'bytes=0-10' } }),
  'GET /api/stories/:id/assistant': p => ({ method: 'GET', url: S(p, '/assistant') }),
  'POST /api/stories/:id/assistant': p => ({ method: 'POST', url: S(p, '/assistant'), payload: { message: 'ubah judul jadi hijack' } }),
  'POST /api/stories/:id/assistant/undo/:undoId': p => ({ method: 'POST', url: S(p, `/assistant/undo/${p.undoId}`), payload: {} }),
  'GET /api/flow/jobs/:id/file': p => ({ method: 'GET', url: `/api/flow/jobs/${p.jobId}/file` }),
  'POST /api/flow/jobs/:id/cancel': p => ({ method: 'POST', url: `/api/flow/jobs/${p.queuedJobId}/cancel`, payload: {} }),
  // Destructive: the owner's pass runs it last.
  'DELETE /api/stories/:id': p => ({ method: 'DELETE', url: S(p) })
};

/** What the registry names but this area does not enforce: Studio / free-generate files belong to area jobs (T4: per-user directories + index). */
const DELEGATED_TO_JOBS = ['GET /api/generate/files/:kind/:name'];
const isOwned = (r: { resource?: string }) => !!r.resource && (r.resource.startsWith('story:') || r.resource === 'flowjob:id' || r.resource === 'genfile');
const ownedRoutes = (): string[] => Object.entries(ROUTE_POLICY).filter(([, r]) => r.policy === 'PENGGUNA-PEMILIK' && isOwned(r)).map(([k]) => k);
const gateRoutes = (): string[] => ownedRoutes().filter(k => !DELEGATED_TO_JOBS.includes(k));
/** Destructive routes last (the undo restores a snapshot, the delete removes the project). */
const ordered = (keys: string[]): string[] => [
  ...keys.filter(k => k !== 'DELETE /api/stories/:id' && !k.endsWith('/assistant/undo/:undoId')),
  ...keys.filter(k => k.endsWith('/assistant/undo/:undoId')),
  ...keys.filter(k => k === 'DELETE /api/stories/:id')
];

const send = (world: World, req: Req, who?: Actor) => world.server.inject({
  method: req.method, url: req.url, headers: { ...(who ? { cookie: who.cookie } : {}), ...(req.headers ?? {}) },
  ...(req.payload === undefined ? {} : { payload: req.payload as string | Buffer | object })
});

/** Everything a stray request could move. */
const footprint = async (world: World) => JSON.stringify({
  tree: treeHash(join(world.dataDir, 'stories')),
  jobs: (await world.flow.listJobs(100000)).map(j => [j.id, j.status, j.prompt]),
  ledger: existsSync(join(world.dataDir, 'quota', 'ledger.json')) ? readFileSync(join(world.dataDir, 'quota', 'ledger.json'), 'utf8') : '',
  chat: world.counters.chat, eleven: world.counters.eleven
});

const ids = (world: World, project: Project): Ids => ({ id: project.id, undoId: project.undoId, uploadFile: project.uploadFile, jobId: world.jobId, queuedJobId: world.queuedJobId });
const GHOST: Ids = { id: 'story_0000000000000000', undoId: 'u_0000000000000000_0000000000000_0000', uploadFile: 'up_0000000000000000.png', jobId: 'job_0000000000000000', queuedJobId: 'job_0000000000000000' };

/** Routes where the OWNER legitimately gets a 404 with the gate's exact body in this fixture (none yet; a route listed here needs a reason). */
const OWN_404_ALLOWED = new Set<string>([]);

let w: World;
beforeAll(async () => {
  makePng(join(tmpdir(), 'nc-matrix-upload.png'), 32, 32);
  w = await makeWorld();
}, 120_000);
afterAll(async () => { while (open.length) await open.pop()!.close().catch(() => undefined); });

// ------------------------------------------------------------------ tests

describe('T3 matrix: the registry drives it', () => {
  it('every PENGGUNA-PEMILIK route that names a project or a job has a fixture; nothing stale; the delegated set is exactly the jobs-area one', () => {
    const owned = ownedRoutes();
    expect(owned.length).toBeGreaterThanOrEqual(40);
    expect(owned.filter(k => !FIXTURES[k] && !DELEGATED_TO_JOBS.includes(k)).sort(), 'rute tanpa fixture: tambahkan fixture').toEqual([]);
    expect(Object.keys(FIXTURES).filter(k => !owned.includes(k)).sort(), 'fixture tanpa rute di registry').toEqual([]);
    expect(DELEGATED_TO_JOBS.every(k => ROUTE_POLICY[k]?.resource === 'genfile')).toBe(true);
  });

  it('a non-owner — admin B or member M — gets the SAME 404 as for a missing project on every route, and nothing moves (anonymous: 401)', async () => {
    const p = ids(w, await w.seedProject(w.a));
    const bad: string[] = [];
    const before = await footprint(w);
    for (const key of ordered(gateRoutes())) {
      const req = FIXTURES[key]!(p);
      const ghostReq = FIXTURES[key]!(GHOST);
      for (const [label, who] of [['admin B', w.b], ['member M', w.m]] as const) {
        const res = await send(w, req, who);
        const ghost = await send(w, ghostReq, who);
        if (res.statusCode !== 404) bad.push(`${key} as ${label} → ${res.statusCode}`);
        else if (res.body !== ghost.body) bad.push(`${key} as ${label}: 404 body differs from a missing project (existence oracle)`);
        if (res.headers['content-range'] || String(res.headers['content-type'] ?? '').includes('event-stream')) bad.push(`${key} as ${label}: leaked media headers`);
      }
      const anon = await send(w, req);
      if (anon.statusCode !== 401) bad.push(`${key} anonymous → ${anon.statusCode}`);
    }
    expect(bad).toEqual([]);
    expect(await footprint(w), 'a refused request moved something').toBe(before);
  }, 180_000);

  it('the owner keeps working on every route (positive control: neither 401/403 nor the gate\'s own 404)', async () => {
    // Its own project: the pass ends with the delete.
    const mineToo = await w.seedProject(w.a);
    const p = ids(w, mineToo);
    const blocked: string[] = [];
    for (const key of ordered(gateRoutes())) {
      const res = await send(w, FIXTURES[key]!(p), w.a);
      const gate404 = res.statusCode === 404 && ['Story not found', 'Job not found'].includes(JSON.parse(res.body)?.error?.message);
      if (res.statusCode === 401 || res.statusCode === 403 || (gate404 && !OWN_404_ALLOWED.has(key))) blocked.push(`${key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(blocked).toEqual([]);
  }, 180_000);
});

describe('T3 matrix: an owner who is only a member keeps their own project (role is not the key to a project any more)', () => {
  it('member-owner reads and lists their project; everyone else gets 404', async () => {
    const mineAm = w.memberOwned;
    const read = await w.server.inject({ url: `/api/stories/${mineAm.id}`, headers: { cookie: w.am.cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect((await w.server.inject({ url: `/api/stories/${mineAm.id}/video`, headers: { cookie: w.am.cookie, range: 'bytes=0-10' } })).statusCode).toBe(206);
    expect((await w.server.inject({ url: `/api/stories/${mineAm.id}/dub`, headers: { cookie: w.am.cookie } })).statusCode).toBe(200);
    const list = (await w.server.inject({ url: '/api/stories', headers: { cookie: w.am.cookie } })).json().stories as Array<{ id: string }>;
    expect(list.map(s => s.id)).toEqual([mineAm.id]);
    for (const who of [w.a, w.b, w.m]) {
      expect((await w.server.inject({ url: `/api/stories/${mineAm.id}`, headers: { cookie: who.cookie } })).statusCode, who.email).toBe(404);
    }
  });
});

describe('T3 matrix: listing and orphans', () => {
  it('GET /api/stories is listFor(user): nobody sees another user\'s title or id (admin included)', async () => {
    const mine = await w.seedProject(w.a);
    const asA = (await w.server.inject({ url: '/api/stories', headers: { cookie: w.a.cookie } })).json().stories as Array<{ id: string }>;
    expect(asA.map(s => s.id)).toContain(mine.id);
    expect(asA.map(s => s.id)).not.toContain(w.memberOwned.id);
    for (const who of [w.b, w.m]) {
      const res = await w.server.inject({ url: '/api/stories', headers: { cookie: who.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body, who.email).not.toContain(mine.id);
      expect(res.body, who.email).not.toContain('Pasar Pagi');
      expect(res.json().stories).toEqual([]);
    }
  });

  it('a project whose creator account is gone (orphan) is invisible to everyone, admin included (only the system admin routes may touch orphans)', async () => {
    const orphan = await w.service.create(bibleBoard(), { createdBy: 'u_deleted_account' });
    for (const who of [w.a, w.b, w.m]) {
      expect((await w.server.inject({ url: `/api/stories/${orphan.id}`, headers: { cookie: who.cookie } })).statusCode, who.email).toBe(404);
      const list = (await w.server.inject({ url: '/api/stories', headers: { cookie: who.cookie } })).json().stories as Array<{ id: string }>;
      expect(list.map(s => s.id), who.email).not.toContain(orphan.id);
    }
  });

  it('a project that never got an owner stays the main owner\'s (Joseph, oldest admin: here A) — and nobody else\'s', async () => {
    const old = await w.service.create(bibleBoard());
    expect((await w.server.inject({ url: `/api/stories/${old.id}`, headers: { cookie: w.a.cookie } })).statusCode).toBe(200);
    expect((await w.server.inject({ url: '/api/stories', headers: { cookie: w.a.cookie } })).json().stories.map((s: { id: string }) => s.id)).toContain(old.id);
    for (const who of [w.b, w.m]) {
      expect((await w.server.inject({ url: `/api/stories/${old.id}`, headers: { cookie: who.cookie } })).statusCode, who.email).toBe(404);
      expect((await w.server.inject({ url: '/api/stories', headers: { cookie: who.cookie } })).json().stories.map((s: { id: string }) => s.id), who.email).not.toContain(old.id);
    }
  });
});

describe('T3 matrix: before the body is read', () => {
  it('an 11 MB upload and a 26 MB music file by a non-owner end in 404 (not 413): the gate runs before the body parser', async () => {
    const p = ids(w, await w.seedProject(w.a));
    for (const who of [w.b, w.m]) {
      const up = await w.server.inject({ method: 'POST', url: S(p, '/uploads'), headers: { cookie: who.cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(11 * 1024 * 1024, 1) });
      expect(up.statusCode, who.email).toBe(404);
      const music = await w.server.inject({ method: 'POST', url: S(p, '/music'), headers: { cookie: who.cookie, 'content-type': 'audio/mpeg' }, payload: Buffer.alloc(26 * 1024 * 1024, 1) });
      expect(music.statusCode, who.email).toBe(404);
    }
    const anon = await w.server.inject({ method: 'POST', url: S(p, '/uploads'), headers: { 'content-type': 'image/png' }, payload: Buffer.alloc(11 * 1024 * 1024, 1) });
    expect(anon.statusCode).toBe(401);
    // The owner's oversize body is still refused as too large (the gate does not change the size rules).
    const own = await w.server.inject({ method: 'POST', url: S(p, '/uploads'), headers: { cookie: w.a.cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(11 * 1024 * 1024, 1) });
    expect(own.statusCode).toBe(413);
  }, 60_000);

  it('assistant SSE: a non-owner never gets a stream and the text model is never called', async () => {
    const p = ids(w, await w.seedProject(w.a));
    const before = w.counters.chat;
    for (const who of [w.b, w.m]) {
      const res = await w.server.inject({ method: 'POST', url: S(p, '/assistant'), headers: { cookie: who.cookie }, payload: { message: 'halo' } });
      expect(res.statusCode, who.email).toBe(404);
      expect(String(res.headers['content-type'])).toContain('application/json');
    }
    expect(w.counters.chat).toBe(before);
  });

  it('media of the owner are private-cacheable only, never public', async () => {
    const p = ids(w, await w.seedProject(w.a));
    for (const url of [S(p, '/video'), S(p, `/shots/${SHOT}/video`), S(p, '/music'), S(p, `/uploads/${p.uploadFile}`), S(p, `/shots/${SHOT}/frame`), S(p, '/cast/LARAS/image')]) {
      const res = await w.server.inject({ url, headers: { cookie: w.a.cookie } });
      expect(res.statusCode, url).toBeLessThan(300);
      expect(String(res.headers['cache-control']), url).toContain('private');
      expect(String(res.headers['cache-control']), url).not.toContain('public');
    }
  });
});

describe('T3 matrix: sibling spellings of the same route do not open a side door', () => {
  it('HEAD (Fastify mirrors every GET), a trailing slash, another letter case and an encoded id: a non-owner never gets anything but 404/401', async () => {
    const p = ids(w, await w.seedProject(w.a));
    const encoded = p.id.replace('story_', '%73tory_');
    for (const who of [w.b, w.m]) {
      for (const url of [S(p, '/video'), S(p, '/dub'), S(p, `/shots/${SHOT}/frame`), S(p, '/music'), S(p)]) {
        expect((await w.server.inject({ method: 'HEAD', url, headers: { cookie: who.cookie } })).statusCode, `HEAD ${url} ${who.email}`).toBe(404);
      }
      expect((await w.server.inject({ url: `/api/stories/${encoded}`, headers: { cookie: who.cookie } })).statusCode, `encoded id ${who.email}`).toBe(404);
      for (const url of [`${S(p)}/`, S(p).replace('/api/', '/API/')]) {
        expect([404], `${url}`).toContain((await w.server.inject({ url, headers: { cookie: who.cookie } })).statusCode);
      }
    }
    // The owner through the same doors: HEAD works, the encoded id is the same project.
    expect((await w.server.inject({ method: 'HEAD', url: S(p, '/video'), headers: { cookie: w.a.cookie } })).statusCode).toBe(200);
    expect((await w.server.inject({ url: `/api/stories/${encoded}`, headers: { cookie: w.a.cookie } })).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------ WAVE 4: the role matrix (workspace members, not creators)

describe('W4 matrix: viewer reads everything, writes nothing; editor works like the owner; a non-member is a 404', () => {
  /** The read half of the fixture set: the same routes with a GET (the write fixtures of those URLs are POST/PUT). */
  const READS = (keys: string[]): string[] => keys.filter(k => k.startsWith('GET '));
  const WRITES = (keys: string[]): string[] => keys.filter(k => !k.startsWith('GET '));

  it('a viewer of the project\'s workspace reads every read route exactly like the owner and gets 403 VIEWER_READ_ONLY on every write, and nothing moves', async () => {
    const mineToo = await w.seedProject(w.a);
    const p = ids(w, mineToo);
    const workspaceId = personalWorkspaceId(w.a.id);
    await setMembership(w.dataDir, { workspaceId, userId: w.av.id, role: 'viewer' });
    const keys = ordered(gateRoutes());
    const bad: string[] = [];

    // Reads: byte-for-byte the status the owner gets (the gate does not narrow what a member may see).
    for (const key of READS(keys)) {
      const viewer = await send(w, FIXTURES[key]!(p), w.av);
      const owner = await send(w, FIXTURES[key]!(p), w.a);
      if (viewer.statusCode === 401 || viewer.statusCode === 403) bad.push(`read ${key} as viewer → ${viewer.statusCode}`);
      else if (viewer.statusCode !== owner.statusCode) bad.push(`read ${key}: viewer ${viewer.statusCode} vs owner ${owner.statusCode}`);
    }

    const before = await footprint(w);
    for (const key of WRITES(keys)) {
      const res = await send(w, FIXTURES[key]!(p), w.av);
      if (res.statusCode !== 403) bad.push(`write ${key} as viewer → ${res.statusCode} ${res.body.slice(0, 60)}`);
      else if (JSON.parse(res.body)?.error?.code !== 'VIEWER_READ_ONLY') bad.push(`write ${key} as viewer: code ${JSON.parse(res.body)?.error?.code}`);
    }
    expect(bad).toEqual([]);
    expect(await footprint(w), 'a refused write moved something').toBe(before);
  }, 180_000);

  it('an editor of the workspace passes every project route like the owner (only member management is out of reach: no such route here)', async () => {
    const mineToo = await w.seedProject(w.a);
    const p = ids(w, mineToo);
    await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.ae.id, role: 'editor' });
    const blocked: string[] = [];
    for (const key of ordered(gateRoutes())) {
      const res = await send(w, FIXTURES[key]!(p), w.ae);
      const gate404 = res.statusCode === 404 && ['Story not found', 'Job not found'].includes(JSON.parse(res.body)?.error?.message);
      if (res.statusCode === 401 || res.statusCode === 403 || (gate404 && !OWN_404_ALLOWED.has(key))) blocked.push(`${key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(blocked).toEqual([]);
  }, 180_000);

  it('access follows the workspace, not the creator: an editor of one workspace sees nothing in another, and the platform admin who is not a member still gets 404', async () => {
    // A second workspace A owns; `ae` (editor of A's personal workspace by the test above) is not invited to this one.
    const other = await createWorkspaceRecord(w.dataDir, { name: 'Tim Lain', ownerId: w.a.id });
    await setMembership(w.dataDir, { workspaceId: other.id, userId: w.a.id, role: 'owner' });
    const elsewhere = await w.service.create(bibleBoard(), { createdBy: w.a.id, workspaceId: other.id });
    expect((await w.server.inject({ url: `/api/stories/${elsewhere.id}`, headers: { cookie: w.ae.cookie } })).statusCode).toBe(404);
    expect((await w.server.inject({ url: `/api/stories/${elsewhere.id}`, headers: { cookie: w.b.cookie } })).statusCode).toBe(404);
    expect((await w.server.inject({ url: `/api/stories/${elsewhere.id}`, headers: { cookie: w.a.cookie } })).statusCode).toBe(200);
  });
});

describe('T3 matrix: system admin, public, shared, bridge', () => {
  it('SISTEM-ADMIN routes: anonymous 401, member 403, admin passes the gate (generated from the registry)', async () => {
    const fill = (url: string) => url.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      if (entry.policy !== 'SISTEM-ADMIN') continue;
      const [method, url] = key.split(' ') as [Req['method'], string];
      const req: Req = { method, url: fill(url), ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) };
      const anon = await send(w, req);
      const member = await send(w, req, w.m);
      const admin = await send(w, req, w.b);
      if (anon.statusCode !== 401) bad.push(`${key} anon → ${anon.statusCode}`);
      if (member.statusCode !== 403) bad.push(`${key} member → ${member.statusCode}`);
      if (admin.statusCode === 401 || admin.statusCode === 403) bad.push(`${key} admin → ${admin.statusCode}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('PUBLIK routes need nothing, PENGGUNA-BERSAMA needs a login only, BRIDGE-TOKEN keeps its own token', async () => {
    expect((await w.server.inject('/api/health')).statusCode).toBe(200);
    expect((await w.server.inject('/api/auth/status')).statusCode).toBe(200);
    expect((await w.server.inject('/api/auth/invites/peek?token=x')).statusCode).not.toBe(401);
    expect((await w.server.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    for (const url of ['/api/stories/catalog', '/api/generate/status', '/api/trends']) {
      expect((await w.server.inject(url)).statusCode, `${url} anon`).toBe(401);
      expect((await w.server.inject({ url, headers: { cookie: w.m.cookie } })).statusCode, `${url} member`).toBeLessThan(400);
    }
    expect((await w.server.inject({ method: 'POST', url: '/api/flow/bridge/heartbeat', payload: { bridgeId: 'mac' } })).statusCode).toBe(401);
    expect((await w.server.inject({ method: 'POST', url: '/api/flow/bridge/heartbeat', headers: { cookie: w.b.cookie }, payload: { bridgeId: 'mac' } })).statusCode).toBe(401);
    expect((await w.server.inject({ method: 'POST', url: '/api/flow/bridge/heartbeat', headers: { 'x-flow-bridge-token': 'bridge-secret-token-1234567890' }, payload: { bridgeId: 'mac', accounts: [] } })).statusCode).toBe(200);
  }, 60_000);
});

// ------------------------------------------------------------------ MCP: the token acts as its owner

describe('T3 matrix: MCP acts as the token owner', () => {
  type Call = { isError: boolean; text: string; json: any };
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let mine: Project;
  beforeAll(async () => {
    mine = await w.seedProject(w.a);
    await w.server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(w.server.server.address() as AddressInfo).port}`;
    const tokens = new McpTokenStore(w.dataDir, w.users);
    tokenA = (await tokens.create(w.a.id, 'A')).token;
    tokenB = (await tokens.create(w.b.id, 'B')).token;
  });
  const connect = async (token: string) => {
    const client = new Client({ name: 'matrix', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Call> => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = res.content[0]!.text;
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { isError: res.isError === true, text, json };
  };

  it('token B: list_projects never lists A\'s project; EVERY action tool on A\'s project is "Proyek tidak ditemukan" and changes nothing', async () => {
    const b = await connect(tokenB);
    const listed = await call(b, 'list_projects', {});
    expect(listed.text).not.toContain(mine.id);
    expect(listed.text).not.toContain('Pasar Pagi');
    const before = await footprint(w);
    const wrong: string[] = [];
    for (const name of ACTION_NAMES) {
      // rev 999 never equals the project's: a tool that got past the owner check would answer "Proyek sudah berubah" instead.
      const res = await call(b, name, { project_id: mine.id, confirm: true, rev: 999 });
      if (!res.isError || !/Proyek tidak ditemukan/.test(res.text)) wrong.push(`${name}: ${res.text.slice(0, 80)}`);
    }
    await b.close();
    expect(wrong).toEqual([]);
    expect(await footprint(w)).toBe(before);
  }, 60_000);

  it('token B: create_project makes a project owned by B; token A still reads its own (positive control) and does not see B\'s', async () => {
    const b = await connect(tokenB);
    const created = await call(b, 'create_project', { premise: 'Seekor kucing mencari rumah baru' });
    expect(created.isError, created.text).toBe(false);
    expect(await w.service.ownerOf(created.json.project_id)).toBe(w.b.id);
    expect((await call(b, 'get_project', { project_id: created.json.project_id })).isError).toBe(false);
    await b.close();
    const a = await connect(tokenA);
    expect((await call(a, 'get_project', { project_id: mine.id })).isError).toBe(false);
    expect((await call(a, 'list_projects', {})).text).not.toContain(created.json.project_id);
    expect((await call(a, 'get_project', { project_id: created.json.project_id })).isError).toBe(true);
    await a.close();
  }, 60_000);
});

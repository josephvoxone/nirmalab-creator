import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';
import { FlowStore } from '../src/flow/store.js';

const BRIDGE = { 'x-flow-bridge-token': 'bridge-token-0123456789abcdef' };
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

/** A = oldest admin (main owner), B = second admin, M = member (no creator role yet). */
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobs-own-'));
  const store = new FlowStore(join(dataDir, 'flow'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'jobs-own-auth-')));
  const a = await auth.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
  const b = await auth.createUser({ email: 'b@x.io', password: 'admin-pass-2', isAdmin: true });
  const m = await auth.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
  server = Fastify();
  await registerFlowRoutes(server, { userAuthStore: auth, dataDir, store, bridgeToken: BRIDGE['x-flow-bridge-token'], env: {} });
  await server.ready();
  await store.addAccount({ label: 'Akun', email: 'acc@x' });
  const cookie = (u: { id: string }) => ({ cookie: `oc_session=${auth.createSession(u.id).token}` });
  const get = (url: string, who?: { cookie: string }) => server!.inject({ url, ...(who ? { headers: who } : {}) });
  const post = (url: string, who: { cookie: string } | undefined, payload: unknown = {}) => server!.inject({ method: 'POST', url, ...(who ? { headers: who } : {}), payload: payload as object });
  return { dataDir, store, auth, A: { ...a, ...cookie(a) }, B: { ...b, ...cookie(b) }, M: { ...m, ...cookie(m) }, get, post };
}

/** A finished job with a clip on disk, created through the same store calls the bridge uses. */
async function doneJob(t: Awaited<ReturnType<typeof setup>>, createdBy: string | undefined, prompt: string, technique?: string) {
  const job = await t.store.createJob({ prompt, kind: 'image', ...(createdBy ? { createdBy } : {}), ...(technique ? { technique } : {}) });
  const claimed = await t.store.claimJob('bridge');
  expect(claimed?.id).toBe(job.id);
  const clips = join(t.dataDir, 'flow', 'clips');
  mkdirSync(clips, { recursive: true });
  const filePath = join(clips, `${job.id}.png`);
  writeFileSync(filePath, Buffer.alloc(2048, 7));
  await t.store.completeJob(job.id, { filePath, bytes: 2048, provider: 'flow' });
  return job;
}

describe('T4/T6: GET /api/flow/jobs is the caller\'s own list', () => {
  it('each user sees only their jobs; ownerless jobs belong to the main owner only; cover/system jobs to nobody', async () => {
    const t = await setup();
    const own = await t.store.createJob({ prompt: 'RAHASIA-A satu', kind: 'image', createdBy: t.A.id });
    const theirs = await t.store.createJob({ prompt: 'RAHASIA-B dua', kind: 'image', createdBy: t.B.id });
    const legacy = await t.store.createJob({ prompt: 'RAHASIA-LAMA tiga', kind: 'image' });
    const cover = await t.store.createJob({ prompt: 'cover bersama', kind: 'image', technique: 'cover:horor' });
    const sys = await t.store.createJob({ prompt: 'sistem', kind: 'image', createdBy: 'system:cover' });

    const idsOf = async (who: { cookie: string }) => {
      const res = await t.get('/api/flow/jobs', who);
      expect(res.statusCode).toBe(200);
      return (res.json().jobs as Array<{ id: string }>).map(j => j.id).sort();
    };
    expect(await idsOf(t.A)).toEqual([own.id, legacy.id].sort());
    expect(await idsOf(t.B)).toEqual([theirs.id]);
    expect(await idsOf(t.M)).toEqual([]);
    expect((await t.get('/api/flow/jobs')).statusCode).toBe(401);
    // nothing of the other users' prompts anywhere in B's payload
    const bBody = (await t.get('/api/flow/jobs', t.B)).body;
    expect(bBody).not.toContain('RAHASIA-A');
    expect(bBody).not.toContain('RAHASIA-LAMA');
    void cover; void sys;
  });
});

describe('T4: GET /api/admin/flow/jobs — queue load without content', () => {
  it('admin only; no prompt, technique, group, characters, result or project name; owner id + email present', async () => {
    const t = await setup();
    await t.store.createJob({ prompt: 'RAHASIA-A satu', kind: 'video', createdBy: t.A.id, group: 'story_0123456789abcdef', technique: 'story:story_0123456789abcdef/s1', characters: [{ name: 'Bayu', look: 'jaket merah' }] });
    await t.store.createJob({ prompt: 'RAHASIA-B dua', kind: 'image', createdBy: t.B.id });
    expect((await t.get('/api/admin/flow/jobs')).statusCode).toBe(401);
    expect((await t.get('/api/admin/flow/jobs', t.M)).statusCode).toBe(403);
    const res = await t.get('/api/admin/flow/jobs', t.B);
    expect(res.statusCode).toBe(200);
    const jobs = res.json().jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    const allowed = new Set(['id', 'kind', 'status', 'provider', 'model', 'accountId', 'attempts', 'error', 'ownerId', 'ownerEmail', 'createdAtMs', 'startedAtMs', 'finishedAtMs', 'credits', 'cancelled']);
    for (const job of jobs) for (const key of Object.keys(job)) expect(allowed.has(key), `key ${key}`).toBe(true);
    expect(res.body).not.toMatch(/RAHASIA|Bayu|jaket|story_0123|prompt|technique|characters/);
    const forA = jobs.find(j => j.ownerId === t.A.id)!;
    expect(forA.ownerEmail).toBe('a@x.io');
    expect(forA.kind).toBe('video');
    expect(forA.credits).toBe(10);
  });
});

describe('T6: GET /api/flow/jobs/:id/file checks the owner', () => {
  it('owner 200; other admin and member 404 with the same body as a missing job; main owner reads ownerless jobs', async () => {
    const t = await setup();
    const mine = await doneJob(t, t.A.id, 'a');
    const bobs = await doneJob(t, t.B.id, 'b');
    const legacy = await doneJob(t, undefined, 'old');
    const file = (id: string, who?: { cookie: string }) => t.get(`/api/flow/jobs/${id}/file`, who);
    expect((await file(mine.id, t.A)).statusCode).toBe(200);
    expect((await file(mine.id, t.A)).rawPayload.byteLength).toBe(2048);
    expect((await file(bobs.id, t.B)).statusCode).toBe(200);
    expect((await file(legacy.id, t.A)).statusCode).toBe(200);
    const missing = await file('job_0000000000000000', t.B);
    for (const [id, who] of [[mine.id, t.B], [mine.id, t.M], [bobs.id, t.A], [legacy.id, t.B], [legacy.id, t.M]] as const) {
      const res = await file(id, who);
      expect(res.statusCode, `${id} as ${who.email}`).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect((await file(mine.id)).statusCode).toBe(401);
  });

  it('a cover job (no createdBy) and a system: job are not readable through a user session', async () => {
    const t = await setup();
    const cover = await doneJob(t, undefined, 'cover', 'cover:horor');
    const sys = await doneJob(t, 'system:cover', 'sys');
    for (const job of [cover, sys]) {
      expect((await t.get(`/api/flow/jobs/${job.id}/file`, t.A)).statusCode).toBe(404);
      expect((await t.get(`/api/flow/jobs/${job.id}/file`, t.B)).statusCode).toBe(404);
    }
  });
});

describe('D7: cancelling', () => {
  it('own queued job cancels; another admin\'s job is 404 on the user route; the admin route cancels a stuck QUEUED job, censored and logged', async () => {
    const t = await setup();
    const mine = await t.store.createJob({ prompt: 'RAHASIA-A satu', kind: 'image', createdBy: t.A.id });
    const stuck = await t.store.createJob({ prompt: 'RAHASIA-A dua', kind: 'image', createdBy: t.A.id });
    expect((await t.post(`/api/flow/jobs/${mine.id}/cancel`, t.B)).statusCode).toBe(404);
    expect((await t.post(`/api/flow/jobs/${mine.id}/cancel`, t.A)).statusCode).toBe(200);

    expect((await t.post(`/api/admin/flow/jobs/${stuck.id}/cancel`, t.M)).statusCode).toBe(403);
    const res = await t.post(`/api/admin/flow/jobs/${stuck.id}/cancel`, t.B);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('RAHASIA');
    const after = await t.store.getJob(stuck.id);
    expect(after?.status).toBe('failed');
    expect(after?.cancelled).toBe(true);
    expect(after?.error).toBe('Dibatalkan oleh pengelola sistem');
    const log = readFileSync(join(t.dataDir, 'audit', 'tenancy-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'flow.job.cancel', jobId: stuck.id, by: t.B.id, ownerId: t.A.id });
    expect(JSON.stringify(log)).not.toContain('RAHASIA');
  });

  it('the admin route refuses a running job (no force), a finished job and a malformed id', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'x', kind: 'image', createdBy: t.A.id });
    await t.store.claimJob('bridge');
    expect((await t.post(`/api/admin/flow/jobs/${job.id}/cancel`, t.B, { force: true })).statusCode).toBe(409);
    expect((await t.post('/api/admin/flow/jobs/nope/cancel', t.B)).statusCode).toBe(404);
    expect(existsSync(join(t.dataDir, 'audit', 'tenancy-log.jsonl'))).toBe(false);
  });
});

describe('bridge routes are unchanged (token, no session)', () => {
  it('claim/complete work with the bridge token for a job of any owner', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'p', kind: 'image', createdBy: t.B.id });
    const claim = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: BRIDGE, payload: { bridgeId: 'b' } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().job.id).toBe(job.id);
    const done = await server!.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`, headers: { ...BRIDGE, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(2048, 3) });
    expect(done.statusCode).toBe(200);
    expect((await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', payload: {} })).statusCode).toBe(401);
  });
});

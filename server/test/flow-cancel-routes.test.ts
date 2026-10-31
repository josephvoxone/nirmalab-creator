import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const BRIDGE = { 'x-flow-bridge-token': 'bridge-token-0123456789abcdef' };
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-cancel-'));
  const store = new FlowStore(join(dataDir, 'flow'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'flow-cancel-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  server = Fastify();
  await registerFlowRoutes(server, { userAuthStore: auth, dataDir, store, bridgeToken: BRIDGE['x-flow-bridge-token'] });
  await server.ready();
  await store.addAccount({ label: 'A', email: 'a@x' });
  return {
    dataDir, store,
    admin: { cookie: `oc_session=${auth.createSession(admin.id).token}` },
    member: { cookie: `oc_session=${auth.createSession(member.id).token}` }
  };
}
const fail = (id: string, error = 'boom') => server!.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${id}/fail`, headers: BRIDGE, payload: { error, cooldownMs: 600_000 } });

describe('S2: bridge /fail only answers for a running job', () => {
  it('queued and done jobs → 409 INVALID_STATE; nothing changes, no account cooldown', async () => {
    const t = await setup();
    const queued = await t.store.createJob({ prompt: 'q', kind: 'image' });
    const r1 = await fail(queued.id);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe('INVALID_STATE');
    expect(await t.store.getJob(queued.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await t.store.claimJob('mac');
    await t.store.completeJob(queued.id, { filePath: '/x.png', bytes: 5 });
    const r2 = await fail(queued.id);
    expect(r2.statusCode).toBe(409);
    expect(await t.store.getJob(queued.id)).toMatchObject({ status: 'done', attempts: 0 });
    expect((await t.store.listAccounts())[0]!.status).toBe('ready');
  });

  it('a running job still fails normally (cooldown applies)', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'x', kind: 'image' });
    await t.store.claimJob('mac');
    expect((await fail(job.id, 'rate limited')).statusCode).toBe(200);
    expect(await t.store.getJob(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await t.store.listAccounts())[0]!.status).toBe('cooldown');
  });
});

describe('S2: POST /api/flow/jobs/:id/cancel', () => {
  const cancel = (id: string, cookie?: string, payload?: unknown) =>
    server!.inject({ method: 'POST', url: `/api/flow/jobs/${id}/cancel`, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });

  it('admin only', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'q', kind: 'video' });
    expect((await cancel(job.id)).statusCode).toBe(401);
    // Wave 4: a non-member (even an admin) gets 404 on a job they cannot see, so its existence does not leak.
    expect((await cancel(job.id, t.member.cookie)).statusCode).toBe(404);
    expect((await t.store.getJob(job.id))?.status).toBe('queued');
  });

  it('queued → failed final "Dibatalkan oleh <user>", attempts unchanged', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'q', kind: 'video' });
    const res = await cancel(job.id, t.admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ status: 'failed', attempts: 0, error: 'Dibatalkan oleh admin@x.io' });
  });

  it('running → 409 unless force; done → 409; unknown/ill-formed id → 404', async () => {
    const t = await setup();
    const job = await t.store.createJob({ prompt: 'q', kind: 'image' });
    await t.store.claimJob('mac');
    const res = await cancel(job.id, t.admin.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
    expect((await cancel(job.id, t.admin.cookie, { force: true })).statusCode).toBe(200);
    expect((await cancel(job.id, t.admin.cookie)).statusCode).toBe(409);
    expect((await cancel('job_0000000000000000', t.admin.cookie)).statusCode).toBe(404);
    expect((await cancel('nope', t.admin.cookie)).statusCode).toBe(404);
    // a force-cancelled running job cannot be completed afterwards by a late bridge upload
    const late = await server!.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`, headers: { ...BRIDGE, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(4000) });
    expect(late.statusCode).toBe(409);
  });
});

const board: Storyboard = {
  title: 'Batal', mode: 'cepat', style: 'Style: x.', audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '01-a', prompt: 'Medium shot, the camera stays still. A lamp glows.', narration: 'Satu.' }]
};

describe('S2: collect treats a cancelled job as final — no new take', () => {
  it('shot becomes failed with the cancel message, attempts stay 0, no new job is created', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-cancel-story-'));
    mkdirSync(dataDir, { recursive: true });
    const flow = new FlowStore(join(dataDir, 'flow'));
    const service = new StoryService({
      dataDir, flow,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1))
    });
    const story = await service.create(board);
    await service.render(story.id, { force: true });
    const [job] = await flow.listJobs();
    expect(job!.status).toBe('queued');
    expect((await flow.cancelJob(job!.id, 'admin@x.io')).ok).toBe(true);
    await service.reconcile(story.id);
    const rec = (await service.get(story.id))!;
    expect(rec.shots[0]).toMatchObject({ status: 'failed', attempts: 0 });
    expect(rec.shots[0]!.error).toBe('Dibatalkan oleh admin@x.io');
    expect(await flow.listJobs()).toHaveLength(1);
  });
});

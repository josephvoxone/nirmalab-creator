import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';

const BRIDGE_TOKEN = 'bridge-token-0123456789abcdef';
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup(store?: import('../src/flow/store.js').FlowStore, dir?: string) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'flow-routes-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'flow-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const adminCookie = `oc_session=${auth.createSession(admin.id).token}`;
  const memberCookie = `oc_session=${auth.createSession(member.id).token}`;
  server = Fastify();
  await registerFlowRoutes(server, { userAuthStore: auth, dataDir, bridgeToken: BRIDGE_TOKEN, ...(store ? { store } : {}) });
  await server.ready();
  return { dataDir, adminCookie, memberCookie };
}

describe('flow admin routes', () => {
  it('menolak tanpa sesi dan non-admin', async () => {
    const { memberCookie } = await setup();
    expect((await server!.inject('/api/flow/accounts')).statusCode).toBe(401);
    const res = await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: memberCookie }, payload: { label: 'A', email: 'a@b.c' } });
    expect(res.statusCode).toBe(403);
  });

  it('admin membuat akun lalu melihatnya di daftar', async () => {
    const { adminCookie } = await setup();
    const created = await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'Akun 1', email: 'a@b.c', profileDir: '/p/1' } });
    expect(created.statusCode).toBe(200);
    const list = await server!.inject({ url: '/api/flow/accounts', headers: { cookie: adminCookie } });
    expect(list.json().accounts).toHaveLength(1);
    expect(list.json().accounts[0].label).toBe('Akun 1');
  });

  it('label duplikat ditolak 409', async () => {
    const { adminCookie } = await setup();
    const payload = { label: 'Akun 1', email: 'a@b.c' };
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload });
    const dup = await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload });
    expect(dup.statusCode).toBe(409);
  });

  it('job dengan prompt kosong ditolak 400', async () => {
    const { adminCookie } = await setup();
    const res = await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: '  ' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('flow bridge routes', () => {
  it('menolak token bridge salah', async () => {
    await setup();
    const res = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': 'wrong' }, payload: { bridgeId: 'mac' } });
    expect(res.statusCode).toBe(401);
  });

  it('claim kosong mengembalikan 204', async () => {
    await setup();
    const res = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    expect(res.statusCode).toBe(204);
  });

  it('alur penuh: enqueue -> claim -> upload mp4 -> admin unduh file', async () => {
    const { adminCookie, dataDir } = await setup();
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'Akun 1', email: 'a@b.c', profileDir: '/p/1' } });
    const job = (await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: 'ombak senja', technique: 'camera-movement/dolly-in', aspect: '9:16', durationSec: 4 } })).json().job;
    expect(job.status).toBe('queued');

    const claim = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().job.id).toBe(job.id);
    expect(claim.json().account.profileDir).toBe('/p/1');

    const mp4 = Buffer.alloc(4096, 7);
    const done = await server!.inject({
      method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`,
      headers: { 'x-flow-bridge-token': BRIDGE_TOKEN, 'content-type': 'application/octet-stream' },
      payload: mp4
    });
    expect(done.statusCode).toBe(200);
    expect(readFileSync(join(dataDir, 'flow', 'clips', `${job.id}.mp4`)).byteLength).toBe(4096);

    const jobs = (await server!.inject({ url: '/api/flow/jobs', headers: { cookie: adminCookie } })).json().jobs;
    expect(jobs[0].status).toBe('done');

    const file = await server!.inject({ url: `/api/flow/jobs/${job.id}/file`, headers: { cookie: adminCookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('video/mp4');
    expect(file.rawPayload.byteLength).toBe(4096);
  });

  it('start-image: the bridge downloads the keyframe of the clip it is running (round-robin upload), nothing else', async () => {
    const { FlowStore } = await import('../src/flow/store.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-routes-'));
    const store = new FlowStore(dataDir);
    await setup(store, dataDir);
    await store.addAccount({ label: 'A', email: 'a@x' });
    mkdirSync(join(dataDir, 'stories', 'story_g'), { recursive: true });
    const frame = join(dataDir, 'stories', 'story_g', 'frame-01-a.png');
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 3)]);
    writeFileSync(frame, jpeg);
    const job = await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startFrame: { mediaId: 'm', caption: 'c' }, startImage: frame });
    const get = (id: string, token = BRIDGE_TOKEN) => server!.inject({ url: `/api/flow/bridge/jobs/${id}/start-image`, headers: { 'x-flow-bridge-token': token } });
    expect((await get(job.id)).statusCode).toBe(409);                 // not running yet
    await store.claimJob('mac');
    expect((await get(job.id, 'wrong')).statusCode).toBe(401);
    const res = await get(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');            // sniffed: Flow keyframes named .png are JPEGs
    expect(res.rawPayload.equals(jpeg)).toBe(true);
    // A path outside the data dir is never served, whatever the job says.
    const evil = await store.createJob({ prompt: 'clip2', kind: 'video', startFrame: { mediaId: 'm', caption: 'c' }, startImage: '/etc/passwd' });
    await store.completeJob(job.id, { filePath: '/x.mp4' });
    await store.claimJob('mac');
    expect((await get(evil.id)).statusCode).toBe(404);
  });

  it('upload kosong/kecil ditolak dan job tidak selesai', async () => {
    const { adminCookie } = await setup();
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'Akun 1', email: 'a@b.c' } });
    const job = (await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: 'x' } })).json().job;
    await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    const res = await server!.inject({
      method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`,
      headers: { 'x-flow-bridge-token': BRIDGE_TOKEN, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10)
    });
    expect(res.statusCode).toBe(400);
  });

  it('fail dengan cooldown memindahkan akun ke cooldown', async () => {
    const { adminCookie } = await setup();
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'Akun 1', email: 'a@b.c' } });
    const job = (await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: 'x' } })).json().job;
    await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    const res = await server!.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/fail`, headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { error: 'rate limited', cooldownMs: 600000 } });
    expect(res.statusCode).toBe(200);
    const accounts = (await server!.inject({ url: '/api/flow/accounts', headers: { cookie: adminCookie } })).json().accounts;
    expect(accounts[0].status).toBe('cooldown');
  });

  it('token bridge dari file secret di dataDir (tanpa env), dibaca ulang saat rotate', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-routes-file-'));
    mkdirSync(join(dataDir, 'flow'), { recursive: true });
    writeFileSync(join(dataDir, 'flow', 'bridge-token'), 'file-token-aaaaaaaaaaaaaaaaaaaa\n', { mode: 0o600 });
    const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'flow-auth-')));
    server = Fastify();
    await registerFlowRoutes(server, { userAuthStore: auth, dataDir });
    await server.ready();
    const claim = (token: string) => server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': token }, payload: { bridgeId: 'mac' } });
    expect((await claim('file-token-aaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(204);
    writeFileSync(join(dataDir, 'flow', 'bridge-token'), 'file-token-bbbbbbbbbbbbbbbbbbbb\n');
    expect((await claim('file-token-aaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(401);
    expect((await claim('file-token-bbbbbbbbbbbbbbbbbbbb')).statusCode).toBe(204);
  });

  it('tanpa env dan tanpa file, semua route bridge 401', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-routes-none-'));
    const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'flow-auth-')));
    server = Fastify();
    await registerFlowRoutes(server, { userAuthStore: auth, dataDir });
    await server.ready();
    const res = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': '' }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('heartbeat menyimpan kredit dan lastSeen bridge', async () => {
    const { adminCookie } = await setup();
    const acc = (await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'Akun 1', email: 'a@b.c' } })).json().account;
    const hb = await server!.inject({ method: 'POST', url: '/api/flow/bridge/heartbeat', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac', accounts: [{ id: acc.id, credits: 103 }] } });
    expect(hb.statusCode).toBe(200);
    const status = (await server!.inject({ url: '/api/flow/accounts', headers: { cookie: adminCookie } })).json();
    expect(status.accounts[0].credits).toBe(103);
    expect(status.bridge.bridgeId).toBe('mac');
    expect(status.bridge.online).toBe(true);
  });

  it('upload hasil keyframe: PNG disimpan sebagai .png dan id Flow dari header tercatat', async () => {
    const { FlowStore } = await import('../src/flow/store.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-routes-'));
    const store = new FlowStore(join(dataDir, 'flow'));
    const { adminCookie } = await setup(store, dataDir);
    const acc = await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'K', email: 'k@x.io' } });
    expect(acc.statusCode).toBe(200);
    const job = await store.createJob({ prompt: 'frame', kind: 'image', group: 'story_0123456789abcdef' });
    const claim = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    expect(claim.json().job).toMatchObject({ id: job.id, kind: 'image' });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000, 1)]);
    const done = await server!.inject({
      method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`, payload: png,
      headers: { 'x-flow-bridge-token': BRIDGE_TOKEN, 'content-type': 'application/octet-stream', 'x-flow-media-id': 'm-123', 'x-flow-caption': encodeURIComponent('Girl on porch') }
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().job.resultPath).toMatch(/clips\/job_[a-f0-9]{16}\.png$/);
    expect(done.json().job.result).toEqual({ mediaId: 'm-123', caption: 'Girl on porch' });
  });

  it('app can queue a still image job; its file is served as an image, not mp4', async () => {
    const { FlowStore } = await import('../src/flow/store.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'flow-routes-'));
    const store = new FlowStore(join(dataDir, 'flow'));
    const { adminCookie } = await setup(store, dataDir);
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie: adminCookie }, payload: { label: 'K', email: 'k@x.io' } });
    const created = await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: 'a lighthouse at dusk', kind: 'image', aspect: '16:9' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().job).toMatchObject({ kind: 'image', aspect: '16:9' });
    const id = created.json().job.id;
    await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 1)]);
    await server!.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${id}/complete`, payload: jpg, headers: { 'x-flow-bridge-token': BRIDGE_TOKEN, 'content-type': 'application/octet-stream' } });
    const file = await server!.inject({ url: `/api/flow/jobs/${id}/file`, headers: { cookie: adminCookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    const vid = await server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie: adminCookie }, payload: { prompt: 'x', kind: 'character' } });
    expect(vid.json().job.kind).toBe('video');
  });
});

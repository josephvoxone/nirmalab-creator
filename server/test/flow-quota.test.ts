import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { UserAuthStore } from '../src/auth/store.js';

const board3 = {
  title: 'Tiga klip',
  shots: [
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Satu.' },
    { id: '02-b', prompt: 'Close-up of the kitten yawning.', narration: 'Dua.' },
    { id: '03-c', prompt: 'Wide shot of the street at dusk.', narration: 'Tiga.' }
  ]
};
const BRIDGE = 'bridge-token-0123456789abcdef';
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-fq-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', OPENCREATOR_FLOW_BRIDGE_TOKEN: BRIDGE },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)), generateText: async () => JSON.stringify(board3) },
    providers: { workerMs: 0 }, dub: { resume: false }
  });
  close = () => server.close();
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const auth = new UserAuthStore(dataDir);
  const admin = auth.findUserByEmail('admin@x.io')!;
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = { cookie }) =>
    server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const limit = (userId: string, limits: unknown) => req('PUT', `/api/quota/limits/${userId}`, { limits });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const story = async () => (await req('POST', '/api/stories', { storyboard: board3 })).json().story.id as string;
  return { server, req, limit, admin, member, flow, dataDir, story, cookie, auth };
}
const clip = { prompt: 'ombak senja', kind: 'video' };

describe('T5b Flow quota: one gate in FlowStore.createJob', () => {
  it('Studio POST: a limit of 20 credits lets two clips through, the third is a 429 QUOTA before any job exists', async () => {
    const t = await setup();
    expect((await t.limit(t.admin.id, { flowCredits: { perDay: 20 } })).statusCode).toBe(200);
    expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(200);
    expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(200);
    const third = await t.req('POST', '/api/flow/jobs', clip);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatchObject({ code: 'QUOTA', kind: 'flowCredits', window: 'day', limit: 20, used: 20, amount: 10 });
    expect(third.json().error.message).toBe('Kuota kredit Flow harianmu habis: terpakai 20 dari 20 kredit hari ini; pekerjaan ini butuh 10. Batas direset pukul 00.00 WITA. Minta pengelola menaikkan batasmu bila perlu.');
    expect(await t.flow.listJobs()).toHaveLength(2);
    // free stills are never refused
    expect((await t.req('POST', '/api/flow/jobs', { prompt: 'a still', kind: 'image' })).statusCode).toBe(200);
  });

  it('default: no limit for Flow — the same three clips all pass', async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(200);
  });

  it('route render: a run that does not fit is refused as a whole (429) with no job and the shots untouched', async () => {
    const t = await setup();
    await t.limit(t.admin.id, { flowCredits: { perDay: 20 } });
    const id = await t.story();
    const res = await t.req('POST', `/api/stories/${id}/render`, {});
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: 'QUOTA', amount: 30, limit: 20 });
    expect(await t.flow.listJobs()).toHaveLength(0);
    const record = (await t.req('GET', `/api/stories/${id}`)).json().story;
    expect(record.shots.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    // one shot fits
    const one = await t.req('POST', `/api/stories/${id}/render`, { shot: '01-a' });
    expect(one.statusCode).toBe(200);
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('a job that ends for good gives its reservation back (failed) or keeps it as spend (done)', async () => {
    const t = await setup();
    await t.limit(t.admin.id, { flowCredits: { perDay: 20 } });
    const a = (await t.req('POST', '/api/flow/jobs', clip)).json().job;
    const b = (await t.req('POST', '/api/flow/jobs', clip)).json().job;
    expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(429);
    await t.req('POST', `/api/flow/jobs/${a.id}/cancel`, {}); // cancelled while queued: 10 credits free again
    expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(200);
    expect((await t.req('POST', '/api/flow/jobs', clip)).statusCode).toBe(429);
    const usage = (await t.req('GET', `/api/quota/limits/${t.admin.id}`)).json().usage.flowCredits;
    expect(usage.reserved).toBe(20);
    void b;
  });

  it('retry: a failed clip retried by a user over the limit is refused, the shot says why instead of hanging as queued', async () => {
    const t = await setup();
    const id = await t.story();
    expect((await t.req('POST', `/api/stories/${id}/render`, { shot: '01-a' })).statusCode).toBe(200);
    const job = (await t.flow.listJobs())[0]!;
    // the bridge fails the job for good: the project asks for a new take, which the quota now refuses
    await t.limit(t.admin.id, { flowCredits: { perDay: 0 } });
    await t.flow.failJob(job.id, 'Flow did not create the video', { final: true });
    await t.req('GET', `/api/stories/${id}`);           // reconcile
    for (let i = 0; i < 3; i++) await t.req('GET', `/api/stories/${id}`);
    const record = (await t.req('GET', `/api/stories/${id}`)).json().story;
    const shot = record.shots.find((s: { id: string }) => s.id === '01-a');
    expect(shot.status).toBe('failed');
    expect(shot.error).toMatch(/Kuota kredit Flow harianmu habis/);
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('limits routes: admin only, numbers only, 404 for strangers, validation, effective numbers, default for members', async () => {
    const t = await setup();
    const memberLogin = await t.server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'member@x.io', password: 'member-pass-1' } });
    const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0]!;
    expect((await t.req('GET', `/api/quota/limits/${t.member.id}`, undefined, { cookie: memberCookie })).statusCode).toBe(403);
    expect((await t.req('PUT', `/api/quota/limits/${t.member.id}`, { limits: {} }, { cookie: memberCookie })).statusCode).toBe(403);
    const got = (await t.req('GET', `/api/quota/limits/${t.member.id}`)).json();
    expect(got.effective.elevenChars).toEqual({ perDay: 2000, per30d: 5000, perRender: 2500 });
    expect(got.effective.flowCredits).toBeUndefined();
    expect(JSON.stringify(got)).not.toMatch(/prompt|title|story/i);
    expect((await t.req('GET', '/api/quota/limits/nobody')).statusCode).toBe(404);
    expect((await t.limit(t.member.id, { elevenChars: { perDay: -5 } })).statusCode).toBe(400);
    expect((await t.limit(t.member.id, { bogus: {} })).statusCode).toBe(400);
    const put = await t.limit(t.member.id, { flowCredits: { perDay: 30 }, elevenChars: { perDay: 100, per30d: null, perRender: null } });
    expect(put.json().effective).toMatchObject({ flowCredits: { perDay: 30 }, elevenChars: { perDay: 100, per30d: null, perRender: null } });
    expect((await t.limit(t.member.id, {})).json().effective.elevenChars.perDay).toBe(2000);
    // the caller's own numbers are in GET /api/quota
    const mine = (await t.req('GET', '/api/quota', undefined, { cookie: memberCookie })).json().mine;
    expect(mine.limits.elevenChars.perDay).toBe(2000);
    expect(mine.usage.elevenChars).toEqual({ day: 0, d30: 0, reserved: 0 });
  });

  it('usage per user per provider (admin overview) counts what finished', async () => {
    const t = await setup();
    const job = (await t.req('POST', '/api/flow/jobs', clip)).json().job;
    await t.flow.addAccount({ label: 'A', email: 'a@x' });
    const bridge = { 'x-flow-bridge-token': BRIDGE };
    expect((await t.server.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: bridge, payload: { bridgeId: 'b1' } })).json().job.id).toBe(job.id);
    const done = await t.server.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${job.id}/complete`, headers: { ...bridge, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(4000, 1) });
    expect(done.statusCode).toBe(200);
    const usage = (await t.req('GET', '/api/quota/usage?days=7')).json();
    expect(usage.users.find((u: { userId: string }) => u.userId === t.admin.id)).toMatchObject({ flowCredits: 10, elevenChars: 0, email: 'admin@x.io' });
  });
});

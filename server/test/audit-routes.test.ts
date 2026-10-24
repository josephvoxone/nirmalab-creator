import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuditLedger } from '../src/audit/ledger.js';
import { FlowStore } from '../src/flow/store.js';
import { OpenRouterConfigStore } from '../src/providers/config.js';
import type { AuditResult } from '../src/audit/vision.js';

const board = {
  title: 'Selendang Merah', mode: 'konsisten', style: 'Style: storybook watercolor.',
  characters: { LARAS: 'a seven-year-old girl with two black braids and a mustard dress' },
  audio: 'Audio: voice-over: "{line}"',
  shots: [{ id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS holds a rabbit on a porch.', narration: 'Namanya Kapas.' }]
};

const lowAudit = (score: number): AuditResult => ({
  score,
  dimensions: { sceneMatch: score, actionMatch: score, moodMatch: score, composition: score },
  issues: score < 70 ? ['the wooden gate is missing'] : [],
  reasoning: 'satu kalimat',
  repair: score < 70 ? 'The wooden gate is missing: add a weathered wooden gate across the lower third.' : '',
  costUsd: 0.002
});

const png = (w: number, h: number) => {
  const b = Buffer.alloc(30_000, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function auditor(scores: number[]) {
  const calls: Array<{ images: string[] }> = [];
  return {
    calls,
    deps: {
      model: async () => 'google/gemini-2.5-flash',
      run: async (input: { images: string[] }) => { calls.push(input); return lowAudit(scores.shift() ?? 90); },
      frames: async () => { throw new Error('not needed in konsisten'); }
    }
  };
}

async function setup(options: { audit?: boolean; scores?: number[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-audit-routes-'));
  const fake = auditor(options.scores ?? [90]);
  server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      ...(options.audit === false ? {} : { audit: fake.deps as never })
    }
  });
  // One login per test file keeps the login rate limiter (10 per 5 min per email) out of the way.
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const adminId = login.json().user.id as string;
  const flow = new FlowStore(join(dataDir, 'flow'));
  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, withCookie = cookie) =>
    server!.inject({ method, url, headers: { cookie: withCookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  /** prepare → sheets → keyframes, the way the bridge does it. */
  const framesReady = async (id: string) => {
    const clips = join(dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const finishAll = async (kind: 'character' | 'image') => {
      for (const job of (await flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
        const file = join(clips, `${job.id}.png`);
        writeFileSync(file, png(720, 1280));
        await flow.completeJob(job.id, { filePath: file, bytes: 30_000, result: { mediaId: `m-${job.id}`, caption: 'c' } });
      }
    };
    await finishAll('character');
    await req('GET', `/api/stories/${id}`);
    await finishAll('image');
    await req('GET', `/api/stories/${id}`);
  };
  /** Finish whatever keyframe the audit asked to repair and let the next audit run. */
  const settle = async (id: string) => {
    for (const job of (await flow.listJobs()).filter(j => j.kind === 'image' && j.status === 'queued')) {
      const file = join(dataDir, 'flow', 'clips', `${job.id}.png`);
      writeFileSync(file, png(720, 1280));
      await flow.completeJob(job.id, { filePath: file, bytes: 30_000, result: { mediaId: `m-${job.id}`, caption: 'c' } });
    }
    return (await req('GET', `/api/stories/${id}`)).json().story;
  };
  return { dataDir, flow, cookie, req, framesReady, settle, audit: fake, adminId };
}

describe('audit over HTTP', () => {
  it('a below-gate keyframe blocks /assemble with 409 and approve-audit unblocks it', async () => {
    const t = await setup({ scores: [61, 61] });
    const id = (await t.req('POST', '/api/stories', { storyboard: board })).json().story.id;
    await t.req('POST', `/api/stories/${id}/prepare`);
    await t.framesReady(id);
    // the first failing audit re-drew the keyframe once; the second one flags the shot
    const settled = await t.settle(id);
    expect(settled.shots[0].audit.score).toBe(61);
    expect(settled.shots[0].needsReview).toBe(true);
    // animate the frame and finish the clip: auto-assembly must still refuse (spec §4.4)
    await t.req('POST', `/api/stories/${id}/render`, {});
    for (const job of (await t.flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued')) {
      const file = join(t.dataDir, 'flow', 'clips', `${job.id}.mp4`);
      writeFileSync(file, Buffer.alloc(20_000, 1));
      await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000 });
    }
    const afterClips = await t.settle(id);
    expect(afterClips.status).toBe('review');
    expect(afterClips.gate.shots.map((s: { id: string }) => s.id)).toEqual(['01-hadiah']);
    const early = await t.req('POST', `/api/stories/${id}/assemble`, {});
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toContain('01-hadiah');

    const approve = await t.req('POST', `/api/stories/${id}/shots/01-hadiah/approve-audit`, {});
    expect(approve.statusCode).toBe(200);
    expect(approve.json().story.shots[0].approvedBy).toBe(t.adminId);
    expect(approve.json().story.shots[0].approvedAtMs).toBeGreaterThan(0);
    expect(approve.json().story.gate).toBeUndefined();
    expect((await t.req('POST', `/api/stories/${id}/shots/nope/approve-audit`, {})).statusCode).toBe(404);
  });

  it('repair re-queues the keyframe with the audit instruction in the prompt', async () => {
    const t = await setup({ scores: [61, 61, 95] });
    const id = (await t.req('POST', '/api/stories', { storyboard: board })).json().story.id;
    await t.req('POST', `/api/stories/${id}/prepare`);
    await t.framesReady(id);
    await t.settle(id);
    const repair = await t.req('POST', `/api/stories/${id}/shots/01-hadiah/repair`, {});
    expect(repair.statusCode).toBe(200);
    expect(repair.json().story.shots[0].needsReview).toBeUndefined();
    const jobs = (await t.flow.listJobs()).filter(j => j.kind === 'image' && j.status === 'queued');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prompt).toContain('weathered wooden gate');
    expect((await t.req('POST', `/api/stories/${id}/shots/NOPE/repair`, {})).statusCode).toBe(404);
  });

  it('needs an admin session', async () => {
    const t = await setup();
    const id = (await t.req('POST', '/api/stories', { storyboard: board })).json().story.id;
    expect((await server!.inject({ method: 'POST', url: `/api/stories/${id}/shots/01-hadiah/approve-audit` })).statusCode).toBe(401);
    expect((await server!.inject({ method: 'POST', url: `/api/stories/${id}/shots/01-hadiah/repair` })).statusCode).toBe(401);
  });

  it('without an OpenRouter key no audit call is made and nothing is flagged', async () => {
    const t = await setup({ audit: false });
    const id = (await t.req('POST', '/api/stories', { storyboard: board })).json().story.id;
    await t.req('POST', `/api/stories/${id}/prepare`);
    await t.framesReady(id);
    const story = (await t.req('GET', `/api/stories/${id}`)).json().story;
    expect(story.shots[0].audit).toBeUndefined();
    expect(story.shots[0].needsReview).toBeUndefined();
    expect(story.status).toBe('review');
  });
});

describe('audit spend in /api/quota', () => {
  it('reports today\'s audit usd and shot count from the ledger', async () => {
    const t = await setup();
    await new AuditLedger(t.dataDir).record({ costUsd: 0.002 });
    await new AuditLedger(t.dataDir).record({ costUsd: 0.003 });
    const quota = (await t.req('GET', '/api/quota')).json();
    expect(quota.audit).toEqual({ spentUsdToday: 0.005, shots: 2 });
  });

  it('starts at zero and ignores yesterday', async () => {
    const t = await setup();
    await new AuditLedger(t.dataDir).record({ atMs: Date.now() - 2 * 86_400_000, costUsd: 0.5 });
    expect((await t.req('GET', '/api/quota')).json().audit).toEqual({ spentUsdToday: 0, shots: 0 });
  });

  it('a real audit call through the app records its usage cost', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-audit-live-'));
    const auditReply = JSON.stringify({
      score: 88, dimensions: { sceneMatch: 88, actionMatch: 88, moodMatch: 88, composition: 88 },
      issues: [], reasoning: 'bagus', repair: ''
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (String(url).endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: auditReply } }], usage: { cost: 0.004 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)) },
      providers: { fetch: fetchImpl, workerMs: 0 }
    });
    const cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } })).headers['set-cookie']).split(';')[0]!;
    const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server!.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
    expect((await req('GET', '/api/providers')).json().openrouter.auditModel).toBe('google/gemini-2.5-flash');
    await new OpenRouterConfigStore(dataDir).update({ apiKey: 'test-key-not-real-1234567890' });
    const id = (await req('POST', '/api/stories', { storyboard: board })).json().story.id;
    await req('POST', `/api/stories/${id}/prepare`);
    const clips = join(dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const flow = new FlowStore(join(dataDir, 'flow'));
    const finishAll = async (kind: 'character' | 'image') => {
      for (const job of (await flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
        const file = join(clips, `${job.id}.png`);
        writeFileSync(file, png(720, 1280));
        await flow.completeJob(job.id, { filePath: file, bytes: 30_000, result: { mediaId: `m-${job.id}`, caption: 'c' } });
      }
    };
    await finishAll('character'); await req('GET', `/api/stories/${id}`);
    await finishAll('image'); const story = (await req('GET', `/api/stories/${id}`)).json().story;
    expect(story.shots[0].audit).toMatchObject({ score: 88, model: 'google/gemini-2.5-flash', costUsd: 0.004 });
    expect(calls.some(u => String(u).endsWith('/chat/completions'))).toBe(true);
    expect((await req('GET', '/api/quota')).json().audit).toEqual({ spentUsdToday: 0.004, shots: 1 });
  });
});

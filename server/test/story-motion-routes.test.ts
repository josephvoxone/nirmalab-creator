import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import type { MotionInput, MotionVerdict } from '../src/stories/service.js';
import { bibleBoard } from './bible-board.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const fail: MotionVerdict = { status: 'fail', score: 38, reasons: ['Gambar berganti/melebur sendiri di detik 1.7'], suggest: { trimOut: 3.4 } };

async function setup(options: { motion?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-motion-routes-'));
  const calls: MotionInput[] = [];
  // The checker is down while the clips come in (collect finds no verdict), then up: only the backfill can check them.
  const state = { up: false };
  const motion = options.motion === false ? {} : { motion: { check: async (input: MotionInput) => { calls.push(input); return state.up ? fail : undefined; } } };
  server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      // clips finished BEFORE motion checking existed: the backfill is the only thing that checks them
      ...motion
    }
  });
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  await new UserAuthStore(dataDir).createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const memberLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'member@x.io', password: 'member-pass-1' } });
  const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0]!;
  const flow = new FlowStore(join(dataDir, 'flow'));
  const req = (method: 'GET' | 'POST', url: string, c = cookie, payload?: unknown) =>
    server!.inject({ method, url, headers: { cookie: c }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { dataDir, flow, req, cookie, memberCookie, calls, state };
}

/** A finished two-clip story whose clips came in while the checker was down: no verdicts yet. */
async function doneStory(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const id = (await t.req('POST', '/api/stories', t.cookie, { storyboard: { ...bibleBoard(), mode: 'cepat' } })).json().story.id as string;
  await t.req('POST', `/api/stories/${id}/render`, t.cookie, { force: true });
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued')) {
    const file = join(dir, `${job.id}.mp4`);
    writeFileSync(file, Buffer.alloc(20_000, 3));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: { mediaId: `m-${job.id}` } });
  }
  const story = (await t.req('GET', `/api/stories/${id}`)).json().story;     // the page's poll reconciles: the clips are collected
  expect(story.shots.map((s: { status: string; motion?: unknown }) => [s.status, s.motion])).toEqual([['done', undefined], ['done', undefined]]);
  return id;
}

describe('POST /api/stories/:id/motion-check', () => {
  it('401 anonymous, 403 member, 404 unknown story', async () => {
    const t = await setup();
    const id = await doneStory(t);
    expect((await server!.inject({ method: 'POST', url: `/api/stories/${id}/motion-check` })).statusCode).toBe(401);
    expect((await t.req('POST', `/api/stories/${id}/motion-check`, t.memberCookie)).statusCode).toBe(403);
    expect((await t.req('POST', '/api/stories/story_0000000000000000/motion-check')).statusCode).toBe(404);
  });

  it('admin: checks the done clips, answers the counts and the story; free (no job added), revision untouched, idempotent', async () => {
    const t = await setup();
    const id = await doneStory(t);
    const jobsBefore = (await t.flow.listJobs()).length;
    const rev = (await t.req('GET', `/api/stories/${id}`)).json().story.rev;
    t.state.up = true;
    const first = await t.req('POST', `/api/stories/${id}/motion-check`);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ checked: 2, skipped: 0, unavailable: 0 });
    expect(body.story.shots.every((s: { motion: { status: string } }) => s.motion.status === 'fail')).toBe(true);
    expect(body.story.rev).toBe(rev);
    expect((await t.flow.listJobs()).length).toBe(jobsBefore);
    const again = await t.req('POST', `/api/stories/${id}/motion-check`);
    expect(again.json()).toMatchObject({ checked: 0, skipped: 2, unavailable: 0 });
    expect(t.calls.filter(c => c.file.endsWith('.mp4'))).toHaveLength(4);       // 2 while the checker was down + 2 for the backfill; the second run added none
  });

  it('without a checker on this server: 400 with a plain message, nothing changes', async () => {
    const t = await setup({ motion: false });
    const id = await doneStory(t);
    const res = await t.req('POST', `/api/stories/${id}/motion-check`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Cek gerak belum tersedia/);
  });
});

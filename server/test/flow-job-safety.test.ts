import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';

// Wave 1 / area A: a job's status is only ever moved by the party that owns that transition.
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-safety-'));
  return { store: new FlowStore(dir), dir };
}
function patchState(dir: string, mutate: (state: any) => void) {
  const file = join(dir, 'flow.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  mutate(state);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'));

describe('S2: failJob only moves a running job', () => {
  it('a done job reported failed late stays done, attempts untouched (was: re-queued, a hidden 10-credit re-render)', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    const job = await store.createJob({ prompt: 'clip', kind: 'video' });
    await store.claimJob('br');
    await store.completeJob(job.id, { filePath: '/x.mp4', bytes: 2048 });
    const out = await store.failJob(job.id, 'late failure report');
    expect(out?.status).toBe('done');
    const stored = await store.getJob(job.id);
    expect(stored).toMatchObject({ status: 'done', attempts: 0, resultPath: '/x.mp4' });
    expect(stored?.error).toBeUndefined();
  });

  it('a failed (final) job and a queued job are not touched by a non-final failJob either', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    const queued = await store.createJob({ prompt: 'q', kind: 'image' });
    expect((await store.failJob(queued.id, 'x'))?.status).toBe('queued');
    expect((await store.getJob(queued.id))?.attempts).toBe(0);
    await store.cancelJob(queued.id, 'u');
    const j = await store.createJob({ prompt: 'p', kind: 'image', maxAttempts: 1 });
    expect((await store.claimJob('br'))?.id).toBe(j.id);
    await store.failJob(j.id, 'boom');
    expect(await store.getJob(j.id)).toMatchObject({ status: 'failed', attempts: 1 });
    await store.failJob(j.id, 'again');
    expect(await store.getJob(j.id)).toMatchObject({ status: 'failed', attempts: 1, error: 'boom' });
  });

  it('final failJob still stops a queued job (story outage stop) without resurrecting anything', async () => {
    const { store } = makeStore();
    const q = await store.createJob({ prompt: 'q', kind: 'video' });
    await store.failJob(q.id, 'stop', { final: true });
    expect((await store.getJob(q.id))?.status).toBe('failed');
  });

  it('property (200 seeded sequences of claim/fail/lease/complete/cancel): attempts ≤ maxAttempts, a done job never changes', async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let run = 0; run < 200; run += 1) {
      const { store, dir } = makeStore();
      await store.addAccount({ label: 'A', email: 'a@x' });
      const jobs = [await store.createJob({ prompt: 'p1', kind: 'video', maxAttempts: 2 }), await store.createJob({ prompt: 'p2', kind: 'image' })];
      const done = new Map<string, string>();
      for (let step = 0; step < 10; step += 1) {
        const target = jobs[Math.floor(rnd() * jobs.length)]!.id;
        const op = Math.floor(rnd() * 6);
        if (op === 0) await store.claimJob(rnd() < 0.5 ? 'br1' : 'br2');
        else if (op === 1) await store.failJob(target, 'err');
        else if (op === 2) await store.failJob(target, 'err', { final: true });
        else if (op === 3) {
          // completion is the owner's transition (the route guards it); a fresh completion defines the snapshot
          if (await store.completeJob(target, { filePath: `/x/${target}.mp4`, bytes: 1 })) done.set(target, JSON.stringify(await store.getJob(target)));
        }
        else if (op === 4) patchState(dir, s => { for (const j of s.jobs) if (j.status === 'running') j.startedAtMs = 1; });
        else await (store as any).cancelJob?.(target, 'tester');
        for (const j of (await store.listJobs())) {
          expect(j.attempts).toBeLessThanOrEqual(j.maxAttempts);
          if (done.has(j.id)) expect(JSON.stringify(j)).toBe(done.get(j.id));
        }
      }
    }
  }, 60_000);
});

describe('S2: cancelJob', () => {
  it('cancels a queued job into a final failure with the operator named, no attempt burnt', async () => {
    const { store } = makeStore();
    const job = await store.createJob({ prompt: 'p', kind: 'video' });
    const out = await store.cancelJob(job.id, 'admin@x.io');
    expect(out.ok).toBe(true);
    expect(await store.getJob(job.id)).toMatchObject({ status: 'failed', attempts: 0, cancelled: true, error: 'Dibatalkan oleh admin@x.io' });
    expect((await store.getJob(job.id))?.finishedAtMs).toBeGreaterThan(0);
  });

  it('refuses running (unless force), done, failed and unknown jobs', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    const running = await store.createJob({ prompt: 'r', kind: 'image' });
    await store.claimJob('br');
    expect(await store.cancelJob(running.id, 'u')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect((await store.getJob(running.id))?.status).toBe('running');
    expect(await store.cancelJob('job_0000000000000000', 'u')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const forced = await store.cancelJob(running.id, 'u', { force: true });
    expect(forced.ok).toBe(true);
    expect(await store.getJob(running.id)).toMatchObject({ status: 'failed', attempts: 0, cancelled: true });
    expect(await store.cancelJob(running.id, 'u')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('force-cancelling a running clip gives back the credits charged at claim', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const clip = await store.createJob({ prompt: 'c', kind: 'video' });
    await store.claimJob('br');
    expect(read(dir).accounts.find((x: any) => x.id === a.id).creditsUsedToday).toBe(10);
    await store.cancelJob(clip.id, 'u', { force: true });
    expect(read(dir).accounts.find((x: any) => x.id === a.id).creditsUsedToday).toBe(0);
  });
});

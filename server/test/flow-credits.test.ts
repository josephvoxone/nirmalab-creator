import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore, REFILL_MS } from '../src/flow/store.js';

// Google Flow (free): 50 credits a day, refreshed 24 h after the first generation of the cycle;
// a failed generation is re-credited. A 6 s clip costs 10.
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-credits-'));
  return { store: new FlowStore(dir), dir };
}
function patchState(dir: string, mutate: (state: any) => void) {
  const file = join(dir, 'flow.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  mutate(state);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'));
const acc = (dir: string, id: string) => read(dir).accounts.find((a: any) => a.id === id);

/** Two accounts; a story group pinned to A (its sheets + keyframes live in A's Flow project). */
async function pinnedToA(credits: { a?: number; b?: number }) {
  const t = makeStore();
  const a = await t.store.addAccount({ label: 'A', email: 'a@x' });
  const b = await t.store.addAccount({ label: 'B', email: 'b@x' });
  await t.store.setPool({ rotation: 'priority' });
  await t.store.updateAccount(b.id, { priority: 5 });
  await t.store.heartbeat('br', [
    ...(credits.a === undefined ? [] : [{ id: a.id, credits: credits.a }]),
    ...(credits.b === undefined ? [] : [{ id: b.id, credits: credits.b }])
  ]);
  const frame = await t.store.createJob({ prompt: 'keyframe', kind: 'image', group: 'story_g' });
  const claimed = await t.store.claimJob('br');
  expect(claimed?.id).toBe(frame.id);
  expect(claimed?.accountId).toBe(a.id);
  await t.store.completeJob(frame.id, { filePath: '/x.png', result: { mediaId: 'media-a', caption: 'c' } });
  return { ...t, a, b };
}

describe('Flow credits: a clip only goes to an account that can pay for it', () => {
  it('an account with fewer credits than a clip costs does not take the clip; free stills still go through', async () => {
    const { store } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.heartbeat('br', [{ id: a.id, credits: 5 }]);
    const clip = await store.createJob({ prompt: 'clip', kind: 'video' });
    const still = await store.createJob({ prompt: 'still', kind: 'image' });
    expect((await store.claimJob('br'))?.id).toBe(still.id);
    await store.completeJob(still.id, { filePath: '/s.png' });
    expect(await store.claimJob('br')).toBeUndefined();
    expect((await store.getJob(clip.id))?.status).toBe('queued');
    // Unknown credits (no heartbeat yet) never blocks: the old behaviour stays.
    const { store: fresh } = makeStore();
    await fresh.addAccount({ label: 'C', email: 'c@x' });
    await fresh.createJob({ prompt: 'clip', kind: 'video' });
    expect(await fresh.claimJob('br')).toBeDefined();
  });

  it('round-robin: a clip whose keyframe file travels (startImage) moves to another account with credits; the group pin stays', async () => {
    const { store, a, b } = await pinnedToA({ a: 0, b: 53 });
    const clip = await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startFrame: { mediaId: 'media-a', caption: 'c' }, startImage: '/data/stories/story_g/frame-01.png' });
    const claimed = await store.claimJob('br');
    expect(claimed?.id).toBe(clip.id);
    expect(claimed?.accountId).toBe(b.id);
    expect(claimed?.startImage).toBe('/data/stories/story_g/frame-01.png');
    // Keyframe redraws keep going to A, where the characters live.
    expect((await store.groupAccount('story_g'))).toBe(a.id);
  });

  it('a clip without a portable keyframe waits for its own account (no silent redraw elsewhere)', async () => {
    const { store } = await pinnedToA({ a: 0, b: 53 });
    await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startFrame: { mediaId: 'media-a', caption: 'c' } });
    expect(await store.claimJob('br')).toBeUndefined();
  });

  it('the pinned account is still preferred while it can pay', async () => {
    const { store, a } = await pinnedToA({ a: 40, b: 53 });
    await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startFrame: { mediaId: 'media-a', caption: 'c' }, startImage: '/f.png' });
    expect((await store.claimJob('br'))?.accountId).toBe(a.id);
  });
});

describe('Flow credits: an account Flow refuses is exhausted until it refills', () => {
  it('"did not create the video" on a low account: the account is marked exhausted, the clip goes back to the queue without burning a take', async () => {
    const { store, dir, a } = await pinnedToA({ a: 10, b: 0 });
    const clip = await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startFrame: { mediaId: 'media-a', caption: 'c' }, startImage: '/f.png' });
    expect((await store.claimJob('br'))?.accountId).toBe(a.id);
    const after = await store.failJob(clip.id, 'Flow agent did not create the video (I will generate a 6-second video…)');
    expect(after).toMatchObject({ status: 'queued', attempts: 0 });
    expect(acc(dir, a.id).exhaustedAtMs).toBeGreaterThan(0);
    // 10 credits on paper, but Flow said no: it does not get the clip again.
    expect(await store.claimJob('br')).toBeUndefined();
  });

  it('the same error on an account with plenty of credits is a normal failed take', async () => {
    const { store, dir, a } = await pinnedToA({ a: 50, b: 0 });
    const clip = await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startImage: '/f.png', startFrame: { mediaId: 'media-a', caption: 'c' } });
    await store.claimJob('br');
    expect(await store.failJob(clip.id, 'Flow agent did not create the video')).toMatchObject({ attempts: 1 });
    expect(acc(dir, a.id).exhaustedAtMs).toBeUndefined();
  });

  it('a refill (credits jump up) clears the exhausted mark and the cycle; the waiting clip resumes on its own', async () => {
    const { store, dir, a } = await pinnedToA({ a: 10, b: 0 });
    const clip = await store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g', startImage: '/f.png', startFrame: { mediaId: 'media-a', caption: 'c' } });
    await store.claimJob('br');
    await store.failJob(clip.id, 'Flow agent did not create the video');
    await store.heartbeat('br', [{ id: a.id, credits: 20 }]); // a re-credited failure is not a refill
    expect(await store.claimJob('br')).toBeUndefined();
    await store.heartbeat('br', [{ id: a.id, credits: 50 }]);
    expect(acc(dir, a.id).exhaustedAtMs).toBeUndefined();
    expect((await store.claimJob('br'))?.id).toBe(clip.id);
  });
});

describe('Flow credits: today\'s count matches what Flow charged', () => {
  it('a failed clip take gives its credits back (Flow re-credits a failed generation); a done clip keeps them', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.heartbeat('br', [{ id: a.id, credits: 50 }]);
    const c1 = await store.createJob({ prompt: 'c1', kind: 'video' });
    await store.claimJob('br');
    expect(acc(dir, a.id).creditsUsedToday).toBe(10);
    await store.failJob(c1.id, 'Flow clip failed');
    expect(acc(dir, a.id).creditsUsedToday).toBe(0);
    await store.claimJob('br');
    await store.completeJob(c1.id, { filePath: '/c.mp4' });
    expect(acc(dir, a.id).creditsUsedToday).toBe(10);
  });
});

describe('Flow credits: when do they come back', () => {
  it('the first paid claim of a cycle starts the 24 h clock; later claims in the cycle do not move it', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.heartbeat('br', [{ id: a.id, credits: 50 }]);
    const run = async (prompt: string, kind: 'image' | 'video') => {
      await store.createJob({ prompt, kind });
      const j = await store.claimJob('br');
      await store.completeJob(j!.id, { filePath: '/x' });
    };
    await run('still', 'image');
    expect(acc(dir, a.id).cycleStartMs).toBeUndefined(); // free stills do not start it
    await run('c1', 'video');
    const start = acc(dir, a.id).cycleStartMs;
    expect(start).toBeGreaterThan(0);
    await run('c2', 'video');
    expect(acc(dir, a.id).cycleStartMs).toBe(start);
    // A cycle older than 24 h is over: the next paid claim starts a new one.
    patchState(dir, s => { s.accounts[0].cycleStartMs = Date.now() - REFILL_MS - 1000; });
    await run('c3', 'video');
    expect(acc(dir, a.id).cycleStartMs).toBeGreaterThan(Date.now() - 5000);
  });

  it('a cycle that began before it was tracked is read from the job history (earliest paid clip in the last 24 h)', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.heartbeat('br', [{ id: a.id, credits: 50 }]);
    const old = await store.createJob({ prompt: 'old', kind: 'video' });
    const early = Date.now() - 2 * 3_600_000;
    patchState(dir, s => {
      const j = s.jobs.find((x: any) => x.id === old.id);
      Object.assign(j, { status: 'done', accountId: a.id, startedAtMs: early, finishedAtMs: early + 60_000 });
      s.jobs.push({ ...j, id: 'job_stale_000000001', startedAtMs: Date.now() - 30 * 3_600_000 }); // yesterday's cycle: ignored
    });
    await store.createJob({ prompt: 'new', kind: 'video' });
    await store.claimJob('br');
    expect(acc(dir, a.id).cycleStartMs).toBe(early);
  });

  it('a stored cycle start later than a paid clip in the same 24 h is corrected from the history', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.heartbeat('br', [{ id: a.id, credits: 0 }]);
    const early = Date.now() - 2 * 3_600_000;
    const job = await store.createJob({ prompt: 'old', kind: 'video' });
    patchState(dir, s => {
      Object.assign(s.jobs.find((x: any) => x.id === job.id), { status: 'done', accountId: a.id, startedAtMs: early });
      s.accounts[0].cycleStartMs = Date.now() - 60_000;   // recorded late (before tracking existed)
    });
    expect((await store.queueStatus()).accounts[0]!.refillAtMs).toBe(early + REFILL_MS);
  });

  it('queueStatus: running and waiting clips, and when the waiting ones resume', async () => {
    const { store, dir, a, b } = await pinnedToA({ a: 0, b: 0 });
    const startA = Date.now() - 10 * 3_600_000, startB = Date.now() - 6 * 3_600_000;
    patchState(dir, s => {
      s.accounts.find((x: any) => x.id === a.id).cycleStartMs = startA;
      s.accounts.find((x: any) => x.id === b.id).cycleStartMs = startB;
    });
    await store.createJob({ prompt: 'c1', kind: 'video', group: 'story_g', startImage: '/1.png', startFrame: { mediaId: 'm', caption: 'c' } });
    await store.createJob({ prompt: 'c2', kind: 'video', group: 'story_g', startImage: '/2.png', startFrame: { mediaId: 'm', caption: 'c' } });
    await store.createJob({ prompt: 's', kind: 'image', group: 'story_g' });
    const q = await store.queueStatus();
    expect(q).toMatchObject({ running: 0, queued: 3, waitingForCredits: 2 });
    // The earliest refill of an account that could take them.
    expect(q.resumeAtMs).toBe(startA + REFILL_MS);
    expect(q.accounts.map(x => [x.label, x.credits, x.refillAtMs])).toEqual([
      ['A', 0, startA + REFILL_MS], ['B', 0, startB + REFILL_MS]
    ]);
  });

  it('queueStatus: nothing is waiting when an account can pay', async () => {
    const { store } = await pinnedToA({ a: 50, b: 0 });
    await store.createJob({ prompt: 'c1', kind: 'video', group: 'story_g', startImage: '/1.png', startFrame: { mediaId: 'm', caption: 'c' } });
    expect(await store.queueStatus()).toMatchObject({ waitingForCredits: 0, resumeAtMs: null });
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import { hashFor, type Storyboard } from '../src/stories/storyboard.js';

// S4 (limited): ONE owner of clip retries (the story's takes), a retake goes to another account when there is one,
// and a clip that Flow refuses on two different accounts needs an edit instead of more takes.
const REFUSED = 'Flow agent did not create the video (I will generate a video of …)';
const board: Storyboard = {
  title: 'Satu klip', mode: 'cepat', style: 'Style: x.', audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '01-a', prompt: 'Medium shot, the camera stays still. A lamp glows.', narration: 'Satu.' }]
};

async function setup(accounts = 2) {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-owner-'));
  mkdirSync(join(dataDir, 'flow'), { recursive: true });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const ids: string[] = [];
  for (let i = 0; i < accounts; i += 1) ids.push((await flow.addAccount({ label: `A${i}`, email: `a${i}@x` })).id);
  await flow.setPool({ rotation: 'priority' });
  for (let i = 0; i < ids.length; i += 1) await flow.updateAccount(ids[i]!, { priority: i * 5 });
  await flow.heartbeat('br', ids.map(id => ({ id, credits: 50 })));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1))
  });
  return { dataDir, flow, service, ids };
}
type T = Awaited<ReturnType<typeof setup>>;

/** The bridge takes the queued job and reports a failure: returns the job as the store now holds it. */
async function bridgeFails(t: T, error: string, bridge = 'mac') {
  const claimed = await t.flow.claimJob(bridge);
  if (!claimed) throw new Error('nothing to claim');
  await t.flow.failJob(claimed.id, error);
  return (await t.flow.getJob(claimed.id))!;
}
const shotOf = async (t: T, id: string) => (await t.service.get(id))!.shots[0]!;
const videoJobs = async (t: T) => (await t.flow.listJobs()).filter(j => j.kind === 'video');

describe('S4: one owner of clip retries', () => {
  it('a Flow clip job gets ONE attempt (the story owns the takes); sheets and keyframes keep 3 (they are free)', async () => {
    const t = await setup();
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    expect((await videoJobs(t))[0]!.maxAttempts).toBe(1);
    const cons = await t.service.create({ ...board, mode: 'konsisten', characters: { LARAS: 'a girl' }, shots: [{ id: '01-a', prompt: 'Medium shot, the camera stays still. LARAS waits.', narration: 'Satu.' }] });
    await t.service.prepare(cons.id);
    const sheet = (await t.flow.listJobs()).find(j => j.kind === 'character')!;
    expect(sheet.maxAttempts).toBe(3);
  });

  it('a clip that keeps failing costs at most 4 Flow attempts per render (was up to 9)', async () => {
    const t = await setup();
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    for (let i = 0; i < 12 && (await shotOf(t, story.id)).status === 'queued'; i += 1) {
      await t.flow.claimJob('mac').then(job => job && t.flow.failJob(job.id, 'Flow clip failed')).catch(() => undefined);
      await t.service.reconcile(story.id);
    }
    expect((await shotOf(t, story.id)).status).toBe('failed');
    const attempts = (await videoJobs(t)).reduce((n, j) => n + j.attempts, 0);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it('retry() gives a failed shot exactly one new take and does not zero its attempts behind the user\'s back', async () => {
    const t = await setup();
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    for (let i = 0; i < 6 && (await shotOf(t, story.id)).status === 'queued'; i += 1) {
      await bridgeFails(t, 'Flow clip failed');
      await t.service.reconcile(story.id);
    }
    expect((await shotOf(t, story.id)).status).toBe('failed');
    const before = (await videoJobs(t)).length;
    await t.service.retry(story.id);
    const queued = await shotOf(t, story.id);
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBeGreaterThan(0);
    expect((await videoJobs(t)).length).toBe(before + 1);
    await bridgeFails(t, 'Flow clip failed');
    await t.service.reconcile(story.id);
    expect((await shotOf(t, story.id)).status).toBe('failed');
    expect((await videoJobs(t)).length).toBe(before + 1);   // no second new take
  });
});

describe('S4: a retake goes to another account', () => {
  it('a clip that just failed on account A is claimed by account B when B can take it', async () => {
    const t = await setup(2);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    const first = await bridgeFails(t, 'Flow clip failed');
    expect(first.accountId).toBe(t.ids[0]);                  // priority puts A first
    await t.service.reconcile(story.id);
    const retake = (await videoJobs(t)).find(j => j.status === 'queued')!;
    expect(retake.avoidAccountId).toBe(t.ids[0]);
    const claimed = await t.flow.claimJob('mac');
    expect(claimed?.id).toBe(retake.id);
    expect(claimed?.accountId).toBe(t.ids[1]);
  });

  it('avoidance is a preference: with one account (or the other one cooling down) the retake still runs', async () => {
    const solo = await setup(1);
    const job = await solo.flow.createJob({ prompt: 'p', kind: 'video', avoidAccountId: solo.ids[0] });
    expect((await solo.flow.claimJob('mac'))?.id).toBe(job.id);
    const duo = await setup(2);
    await duo.flow.coolDown(duo.ids[1]!, 5 * 60_000);
    const j2 = await duo.flow.createJob({ prompt: 'p', kind: 'video', avoidAccountId: duo.ids[0] });
    const claimed = await duo.flow.claimJob('mac');
    expect(claimed?.id).toBe(j2.id);
    expect(claimed?.accountId).toBe(duo.ids[0]);
  });

  it('jobs created before the field existed (no avoidAccountId) claim exactly as before', async () => {
    const t = await setup(2);
    const job = await t.flow.createJob({ prompt: 'p', kind: 'video' });
    expect((await t.flow.claimJob('mac'))?.accountId).toBe(t.ids[0]);
    expect(job.avoidAccountId).toBeUndefined();
  });
});

describe('S4: Flow refuses the clip on two accounts → needsEdit, not more takes', () => {
  it('two different accounts both answer "did not create the video" with credits to spare: the shot waits for an edit', async () => {
    const t = await setup(2);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    await bridgeFails(t, REFUSED);
    await t.service.reconcile(story.id);
    expect((await shotOf(t, story.id)).status).toBe('queued');
    await bridgeFails(t, REFUSED);
    await t.service.reconcile(story.id);
    const shot = await shotOf(t, story.id);
    expect(shot).toMatchObject({ status: 'failed', needsEdit: true });
    expect(shot.error).toMatch(/menolak/i);
    expect(shot.error).toMatch(/ubah/i);
    expect(shot.error).toMatch(/2 akun/);
    expect((await videoJobs(t)).length).toBe(2);              // no third take
    expect((await t.service.get(story.id))!.status).toBe('failed');
  });

  it('the same account refusing twice is not "consistent across accounts" (could be that account alone)', async () => {
    const t = await setup(1);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    await bridgeFails(t, REFUSED);
    await t.service.reconcile(story.id);
    await bridgeFails(t, REFUSED);
    await t.service.reconcile(story.id);
    const shot = await shotOf(t, story.id);
    expect(shot.needsEdit).toBeUndefined();
    expect(shot.status).toBe('queued');                        // third take still allowed
  });

  it('a refusal on an account that is out of credits is not a content refusal (the store parks it, nothing counted)', async () => {
    const t = await setup(2);
    await t.flow.heartbeat('br', [{ id: t.ids[0]!, credits: 5 }, { id: t.ids[1]!, credits: 5 }]);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    const claimed = await t.flow.claimJob('mac');
    expect(claimed).toBeUndefined();                           // no account can pay: it waits for the refill
    expect((await shotOf(t, story.id)).needsEdit).toBeUndefined();
  });

  it('"Ulangi yang gagal" skips a needsEdit shot and spends nothing on it', async () => {
    const t = await setup(2);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    await bridgeFails(t, REFUSED); await t.service.reconcile(story.id);
    await bridgeFails(t, REFUSED); await t.service.reconcile(story.id);
    expect((await shotOf(t, story.id)).needsEdit).toBe(true);
    const jobs = (await videoJobs(t)).length;
    await t.service.retry(story.id);
    expect((await videoJobs(t)).length).toBe(jobs);            // no credits spent blindly
    expect((await shotOf(t, story.id)).status).toBe('failed');
  });
});

describe('S4: needsEdit and a plain Render', () => {
  it('rendering the whole run skips a needsEdit shot; naming the shot renders it once more (and clears the flag)', async () => {
    const t = await setup(2);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    await bridgeFails(t, REFUSED); await t.service.reconcile(story.id);
    await bridgeFails(t, REFUSED); await t.service.reconcile(story.id);
    expect((await shotOf(t, story.id)).needsEdit).toBe(true);
    const jobs = (await videoJobs(t)).length;
    await t.service.render(story.id, { force: true });
    expect((await videoJobs(t)).length).toBe(jobs);
    await t.service.render(story.id, { force: true, shot: '01-a' });
    expect((await videoJobs(t)).length).toBe(jobs + 1);
    expect((await shotOf(t, story.id)).needsEdit).toBeUndefined();
    // one more refusal and it is flagged again at once (the refusing accounts are remembered)
    await bridgeFails(t, REFUSED); await t.service.reconcile(story.id);
    expect((await shotOf(t, story.id)).needsEdit).toBe(true);
  });
});

describe('S4: paid clips never go stale', () => {
  it('the clip hash of an existing board is byte-identical to the one 58b44cc computed, and queueShot stores exactly it', async () => {
    const t = await setup();
    // 5cba32c6c5d351e0 was computed on 58b44cc (storyboard.ts is unchanged since): a different value would re-render paid clips.
    expect(hashFor(board, board.shots[0]!)).toBe('5cba32c6c5d351e0');
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    expect((await shotOf(t, story.id)).promptHash).toBe('5cba32c6c5d351e0');
  });
});

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';

// F3: the 500-job window used to cut by position. 500 newer jobs (other users' stills) pushed a queued
// clip out of flow.json: the story saw "Job Flow hilang", burnt a take and re-queued (a second render).
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-retention-'));
  writeFileSync(join(dir, 'flow.json'), JSON.stringify({ version: 1, accounts: [], jobs: [] }), { mode: 0o600 });
  return { store: new FlowStore(dir), dir };
}
function patchState(dir: string, mutate: (state: any) => void) {
  const file = join(dir, 'flow.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  mutate(state);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'));
/** `n` finished jobs created now (newest in the array), as another user's Studio work would leave behind. */
function doneJobs(n: number, prefix: string, createdAtMs = Date.now()) {
  return Array.from({ length: n }, (_, i) => ({
    id: `job_${prefix}${String(i).padStart(8 - prefix.length, '0')}`.padEnd(20, '0').slice(0, 20),
    kind: 'image', prompt: 'x', aspect: '9:16', durationSec: 6, status: 'done', attempts: 0, maxAttempts: 3,
    createdAtMs: createdAtMs + i, finishedAtMs: createdAtMs + i + 1, resultPath: `/c/${prefix}${i}.png`, bytes: 1, provider: 'flow'
  }));
}

describe('F3: queued/running jobs are never evicted by the history window', () => {
  it('a queued clip and a running still survive 600 newer finished jobs; finished ones are capped', async () => {
    const { store, dir } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    const queued = await store.createJob({ prompt: 'my clip', kind: 'video' });
    const running = await store.createJob({ prompt: 'my still', kind: 'image' });
    await store.claimJob('br'); // oldest queued = the clip → running; keep the still queued
    patchState(dir, s => { s.jobs.push(...doneJobs(600, 'a')); });
    await store.createJob({ prompt: 'trigger a write', kind: 'image' });
    expect((await store.getJob(queued.id))?.status).toBe('running');
    expect((await store.getJob(running.id))?.status).toBe('queued');
    const jobs = read(dir).jobs as Array<{ status: string }>;
    expect(jobs.filter(j => j.status === 'done').length).toBeLessThanOrEqual(500);
    expect(jobs.filter(j => j.status === 'queued' || j.status === 'running').length).toBe(3);
  });

  it('600 queued jobs are all kept (waiting work has its own limit, not the history window)', async () => {
    const { store, dir } = makeStore();
    patchState(dir, s => { s.accounts = []; s.jobs = doneJobs(600, 'q').map(j => ({ ...j, status: 'queued', resultPath: undefined })); s.version = 1; });
    await store.createJob({ prompt: 'one more', kind: 'image' });
    expect((read(dir).jobs as unknown[]).length).toBe(601);
  });

  it('the Job-lost case from the audit: a story can still read the queued job after 500 others were created', async () => {
    const { store } = makeStore();
    const mine = await store.createJob({ prompt: 'shot clip', kind: 'video', technique: 'story:story_x/01-a' });
    for (let i = 0; i < 520; i += 1) {
      const j = await store.createJob({ prompt: `s${i}`, kind: 'image' });
      await store.completeJob(j.id, { filePath: `/c/${i}.png`, bytes: 1 });
    }
    expect((await store.getJob(mine.id))?.id).toBe(mine.id);
    expect((await store.getJob(mine.id))?.status).toBe('queued');
  }, 60_000);
});

describe('F3: history beyond the window stays readable (usage reports, reuse of old clips)', () => {
  it('usage() still counts jobs trimmed from flow.json; getJob finds an old finished job', async () => {
    const { store, dir } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    patchState(dir, s => { s.jobs.push(...doneJobs(540, 'h')); });
    await store.createJob({ prompt: 'trigger', kind: 'image' });
    const inFile = read(dir).jobs as Array<{ id: string }>;
    expect(inFile.length).toBeLessThan(541);               // the window did trim
    const report = await store.usage({ days: 7 });
    expect(report.totals.jobs).toBe(541);                   // …but nothing vanished from the report
    expect(report.totals.done).toBe(540);
    const trimmed = doneJobs(540, 'h')[0]!;                 // oldest = first trimmed
    expect(inFile.some(j => j.id === trimmed.id)).toBe(false);
    expect((await store.getJob(trimmed.id))?.status).toBe('done');
    expect((await store.getJob(trimmed.id))?.resultPath).toBe('/c/h0.png');
    // listJobs (the admin list) stays the in-file window
    expect((await store.listJobs(10_000)).length).toBe(inFile.length);
  });

  it('history file is private (0600), absent history is fine, and a job is never counted twice', async () => {
    const { store, dir } = makeStore();
    expect((await store.usage({ days: 7 })).totals.jobs).toBe(0);
    patchState(dir, s => { s.jobs.push(...doneJobs(505, 'p')); });
    await store.createJob({ prompt: 'trigger', kind: 'image' });
    await store.createJob({ prompt: 'trigger 2', kind: 'image' });
    const history = join(dir, 'flow-history.jsonl');
    expect(existsSync(history)).toBe(true);
    expect(statSync(history).mode & 0o777).toBe(0o600);
    const ids = readFileSync(history, 'utf8').trim().split('\n').map(l => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await store.usage({ days: 7 })).totals.jobs).toBe(507);
  });
});

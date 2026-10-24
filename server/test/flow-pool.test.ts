import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore, flowDay } from '../src/flow/store.js';

function makeStore(): { store: FlowStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-pool-'));
  return { store: new FlowStore(dir), dir };
}

function patchState(dir: string, mutate: (state: any) => void) {
  const file = join(dir, 'flow.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  mutate(state);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

const acc = (state: any, id: string) => state.accounts.find((a: any) => a.id === id);
const usedToday = (dir: string, id: string, credits: number) =>
  patchState(dir, s => { acc(s, id).creditsUsedToday = credits; acc(s, id).dayStamp = flowDay(Date.now()); });

describe('flowDay', () => {
  it('stamps days in Asia/Makassar (UTC+8)', () => {
    expect(flowDay(Date.parse('2026-10-23T15:59:59Z'))).toBe('2026-10-23');
    expect(flowDay(Date.parse('2026-10-23T16:00:00Z'))).toBe('2026-10-24');
  });
});

describe('FlowStore legacy flow.json', () => {
  it('loads a file written before pool/enabled/priority/cap/createdBy existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-legacy-'));
    writeFileSync(join(dir, 'flow.json'), JSON.stringify({
      version: 1,
      accounts: [{ id: 'acc_0123456789abcdef', label: 'Lama', email: 'l@x', status: 'ready', creditsUsedToday: 2, dayStamp: '2026-01-01', createdAtMs: 1 }],
      jobs: [{ id: 'job_0123456789abcdef', prompt: 'p', aspect: '9:16', durationSec: 6, status: 'queued', attempts: 0, maxAttempts: 3, createdAtMs: 2 }],
      groupAccounts: {}
    }), { mode: 0o600 });
    const store = new FlowStore(dir);
    const [account] = await store.listAccounts();
    expect(account).toMatchObject({ enabled: true, priority: 0, creditsUsedToday: 0 });
    expect(account!.dailyCreditCap).toBeUndefined();
    expect(await store.getPool()).toEqual({ rotation: 'least-used' });
    const job = await store.claimJob('mac');
    expect(job).toMatchObject({ id: 'job_0123456789abcdef', kind: 'video', accountId: 'acc_0123456789abcdef' });
    expect(job!.createdBy).toBeUndefined();
  });
});

describe('FlowStore pool settings', () => {
  it('defaults to least-used and persists a new rotation', async () => {
    const { store, dir } = makeStore();
    expect(await store.getPool()).toEqual({ rotation: 'least-used' });
    expect(await store.setPool({ rotation: 'round-robin' })).toEqual({ rotation: 'round-robin' });
    expect(await new FlowStore(dir).getPool()).toEqual({ rotation: 'round-robin' });
  });

  it('rejects an unknown rotation', async () => {
    const { store } = makeStore();
    await expect(store.setPool({ rotation: 'random' as never })).rejects.toThrow(/rotation/i);
  });
});

describe('FlowStore rotation strategies', () => {
  async function twoAccounts() {
    const t = makeStore();
    const a = await t.store.addAccount({ label: 'A', email: 'a@x' });
    const b = await t.store.addAccount({ label: 'B', email: 'b@x' });
    // A: heavy use today but long ago; B: unused today but used a moment ago.
    patchState(t.dir, s => {
      Object.assign(acc(s, a.id), { creditsUsedToday: 50, dayStamp: flowDay(Date.now()), lastUsedAtMs: Date.now() - 3_600_000 });
      Object.assign(acc(s, b.id), { creditsUsedToday: 0, dayStamp: flowDay(Date.now()), lastUsedAtMs: Date.now() - 1_000 });
    });
    await t.store.createJob({ prompt: 'p' });
    return { ...t, a, b };
  }

  it('least-used picks the lowest creditsUsedToday', async () => {
    const { store, b } = await twoAccounts();
    expect((await store.claimJob('mac'))?.accountId).toBe(b.id);
  });

  it('round-robin picks the account used longest ago, never-used first', async () => {
    const { store, a, dir } = await twoAccounts();
    await store.setPool({ rotation: 'round-robin' });
    expect((await store.claimJob('mac'))?.accountId).toBe(a.id);
    const c = await store.addAccount({ label: 'C', email: 'c@x' });
    patchState(dir, s => { delete acc(s, c.id).lastUsedAtMs; });
    await store.createJob({ prompt: 'p2' });
    expect((await store.claimJob('mac-2'))?.accountId).toBe(c.id);
  });

  it('priority picks the lowest priority number, then least-used', async () => {
    const { store, a, b } = await twoAccounts();
    await store.setPool({ rotation: 'priority' });
    await store.updateAccount(a.id, { priority: 1 });
    await store.updateAccount(b.id, { priority: 2 });
    expect((await store.claimJob('mac'))?.accountId).toBe(a.id);
    await store.updateAccount(a.id, { priority: 2 });
    await store.createJob({ prompt: 'p2' });
    // equal priority → least-used (B has 0 credits today, A has 60 now)
    expect((await store.claimJob('mac-2'))?.accountId).toBe(b.id);
  });
});

describe('FlowStore eligibility: enabled + daily cap', () => {
  it('skips disabled accounts; nothing claimable when all are disabled', async () => {
    const { store } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const b = await store.addAccount({ label: 'B', email: 'b@x' });
    await store.updateAccount(a.id, { enabled: false });
    await store.createJob({ prompt: 'p' });
    expect((await store.claimJob('mac'))?.accountId).toBe(b.id);
    await store.updateAccount(b.id, { enabled: false });
    await store.createJob({ prompt: 'p2' });
    expect(await store.claimJob('mac-2')).toBeUndefined();
  });

  it('charges CREDITS_PER_SHOT per video claim and 0 per image/character claim', async () => {
    const { store } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.createJob({ prompt: 'v', kind: 'video' });
    await store.claimJob('m1');
    expect((await store.getAccount(a.id))!.creditsUsedToday).toBe(10);
    await store.createJob({ prompt: 'i', kind: 'image' });
    await store.claimJob('m2');
    await store.createJob({ prompt: 'c', kind: 'character' });
    await store.claimJob('m3');
    expect((await store.getAccount(a.id))!.creditsUsedToday).toBe(10);
  });

  it('a capped-out account cannot take a video but can still take free images', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.updateAccount(a.id, { dailyCreditCap: 15 });
    usedToday(dir, a.id, 10);
    const video = await store.createJob({ prompt: 'v', kind: 'video' });
    expect(await store.claimJob('m1')).toBeUndefined();
    const image = await store.createJob({ prompt: 'i', kind: 'image' });
    expect((await store.claimJob('m2'))?.id).toBe(image.id);
    // exactly at the cap is allowed
    await store.updateAccount(a.id, { dailyCreditCap: 20 });
    expect((await store.claimJob('m3'))?.id).toBe(video.id);
  });

  it('a capped account hands videos to another eligible account', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const b = await store.addAccount({ label: 'B', email: 'b@x' });
    await store.updateAccount(a.id, { dailyCreditCap: 5, priority: 0 });
    await store.updateAccount(b.id, { priority: 9 });
    await store.setPool({ rotation: 'priority' });
    usedToday(dir, b.id, 200);
    await store.createJob({ prompt: 'v' });
    expect((await store.claimJob('m1'))?.accountId).toBe(b.id);
  });
});

describe('FlowStore group pinning with pool rules', () => {
  async function pinned() {
    const t = makeStore();
    const a = await t.store.addAccount({ label: 'A', email: 'a@x' });
    const b = await t.store.addAccount({ label: 'B', email: 'b@x' });
    usedToday(t.dir, b.id, 100); // least-used → A takes the first group job
    await t.store.createJob({ prompt: 'sheet', kind: 'character', group: 'story_g' });
    const first = await t.store.claimJob('m1');
    expect(first?.accountId).toBe(a.id);
    await t.store.completeJob(first!.id, { filePath: '/x.png' });
    await t.store.createJob({ prompt: 'clip', kind: 'video', group: 'story_g' });
    return { ...t, a, b };
  }

  it('waits for its account when that account is capped out (does not move)', async () => {
    const { store, a } = await pinned();
    await store.updateAccount(a.id, { dailyCreditCap: 5 });
    expect(await store.claimJob('m2')).toBeUndefined();
  });

  it('moves and re-pins when its account is disabled', async () => {
    const { store, a, b } = await pinned();
    await store.updateAccount(a.id, { enabled: false });
    expect((await store.claimJob('m2'))?.accountId).toBe(b.id);
    await store.updateAccount(a.id, { enabled: true });
    await store.createJob({ prompt: 'clip 2', kind: 'video', group: 'story_g' });
    expect((await store.claimJob('m3'))?.accountId).toBe(b.id);
  });

  it('moves and re-pins when its account is deleted', async () => {
    const { store, a, b } = await pinned();
    await store.removeAccount(a.id);
    expect((await store.claimJob('m2'))?.accountId).toBe(b.id);
    const c = await store.addAccount({ label: 'C', email: 'c@x' });
    await store.createJob({ prompt: 'clip 2', kind: 'video', group: 'story_g' });
    expect((await store.claimJob('m3'))?.accountId).toBe(b.id);
    expect(c.id).not.toBe(b.id);
  });
});

describe('FlowStore.updateAccount', () => {
  it('patches label/enabled/priority/cap and clears the cap with null', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const updated = await store.updateAccount(a.id, { label: ' Utama ', enabled: false, priority: 3, dailyCreditCap: 120 });
    expect(updated).toMatchObject({ id: a.id, label: 'Utama', enabled: false, priority: 3, dailyCreditCap: 120 });
    expect((await new FlowStore(dir).getAccount(a.id))).toMatchObject({ label: 'Utama', enabled: false, priority: 3, dailyCreditCap: 120 });
    const cleared = await store.updateAccount(a.id, { dailyCreditCap: null });
    expect(cleared!.dailyCreditCap).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8')).accounts[0]).not.toHaveProperty('dailyCreditCap');
  });

  it('returns undefined for an unknown id', async () => {
    const { store } = makeStore();
    expect(await store.updateAccount('acc_nope', { enabled: false })).toBeUndefined();
  });

  it('validates the patch', async () => {
    const { store } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.addAccount({ label: 'B', email: 'b@x' });
    await expect(store.updateAccount(a.id, { priority: 1.5 })).rejects.toThrow(/priority/i);
    await expect(store.updateAccount(a.id, { dailyCreditCap: -1 })).rejects.toThrow(/cap/i);
    await expect(store.updateAccount(a.id, { dailyCreditCap: Number.NaN })).rejects.toThrow(/cap/i);
    await expect(store.updateAccount(a.id, { label: '  ' })).rejects.toThrow(/label/i);
    await expect(store.updateAccount(a.id, { label: 'b' })).rejects.toThrow(/duplicate/i);
    expect(await store.getAccount(a.id)).toMatchObject({ label: 'A', priority: 0, enabled: true });
  });
});

describe('FlowStore usage report', () => {
  it('createJob records createdBy', async () => {
    const { store } = makeStore();
    const job = await store.createJob({ prompt: 'p', createdBy: 'u_1' });
    expect(job.createdBy).toBe('u_1');
    expect((await store.getJob(job.id))!.createdBy).toBe('u_1');
  });

  it('aggregates jobs per day (UTC+8), account, kind and member', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const b = await store.addAccount({ label: 'B', email: 'b@x' });
    await store.updateAccount(a.id, { dailyCreditCap: 100 });
    await store.updateAccount(b.id, { enabled: false });
    usedToday(dir, a.id, 30);
    const at = (iso: string) => Date.parse(iso);
    const job = (id: string, kind: string, status: string, createdAt: string, accountId?: string, createdBy?: string) => ({
      id, kind, status, prompt: 'p', aspect: '9:16', durationSec: 6, attempts: 0, maxAttempts: 3, createdAtMs: at(createdAt),
      ...(accountId ? { accountId } : {}), ...(createdBy ? { createdBy } : {})
    });
    patchState(dir, s => {
      s.jobs = [
        job('j1', 'video', 'done', '2026-10-23T17:00:00Z', a.id, 'u1'), // 10-24 WITA
        job('j2', 'video', 'failed', '2026-10-21T16:30:00Z', a.id, 'u1'), // 10-22 WITA
        job('j3', 'image', 'done', '2026-10-22T20:00:00Z', b.id, 'u2'), // 10-23
        job('j4', 'character', 'done', '2026-10-23T02:00:00Z', b.id), // 10-23, no member
        job('j5', 'video', 'queued', '2026-10-24T08:00:00Z', undefined, 'u2'), // 10-24
        job('j6', 'video', 'running', '2026-10-24T05:00:00Z', b.id, 'u1'), // 10-24
        job('j7', 'video', 'done', '2026-10-20T05:00:00Z', a.id, 'u1'), // before range
        job('j8', 'video', 'done', '2026-10-24T03:00:00Z', 'acc_gone', 'u2'), // deleted account
        job('j9', 'video', 'done', '2026-10-21T15:59:00Z', a.id, 'u1') // 10-21 WITA: just before range
      ];
    });
    const report = await store.usage({ days: 3, nowMs: at('2026-10-24T09:00:00Z') });
    expect(report.range).toEqual({ from: '2026-10-22', to: '2026-10-24', days: 3 });
    expect(report.totals).toEqual({ jobs: 7, done: 4, failed: 1, running: 1, queued: 1, credits: 20 });
    expect(report.byDay).toEqual([
      { date: '2026-10-22', jobs: 1, done: 0, failed: 1, credits: 0 },
      { date: '2026-10-23', jobs: 2, done: 2, failed: 0, credits: 0 },
      { date: '2026-10-24', jobs: 4, done: 2, failed: 0, credits: 20 }
    ]);
    expect(report.byKind).toEqual({
      video: { jobs: 5, done: 2, credits: 20 },
      image: { jobs: 1, done: 1, credits: 0 },
      character: { jobs: 1, done: 1, credits: 0 }
    });
    const byAcc = Object.fromEntries(report.byAccount.map(r => [r.accountId, r]));
    expect(byAcc[a.id]).toMatchObject({ label: 'A', jobs: 2, done: 1, failed: 1, credits: 10, enabled: true, dailyCreditCap: 100, creditsUsedToday: 30, creditsRemaining: 70 });
    expect(byAcc[b.id]).toMatchObject({ label: 'B', jobs: 3, done: 2, failed: 0, credits: 0, enabled: false, creditsUsedToday: 0 });
    expect(byAcc[b.id]).not.toHaveProperty('creditsRemaining');
    expect(byAcc[b.id]).not.toHaveProperty('dailyCreditCap');
    expect(byAcc.acc_gone).toMatchObject({ jobs: 1, done: 1, credits: 10, enabled: false, deleted: true });
    expect(report.byMember).toEqual([
      { userId: 'u1', jobs: 3, done: 1, credits: 10 },
      { userId: 'u2', jobs: 3, done: 2, credits: 10 },
      { userId: 'unknown', jobs: 1, done: 1, credits: 0 }
    ]);
  });

  it('lists every day of the range even with no jobs, clamping days to 1..90', async () => {
    const { store } = makeStore();
    const now = Date.parse('2026-10-24T09:00:00Z');
    expect((await store.usage({ days: 0, nowMs: now })).byDay).toEqual([{ date: '2026-10-24', jobs: 0, done: 0, failed: 0, credits: 0 }]);
    const wide = await store.usage({ days: 500, nowMs: now });
    expect(wide.byDay).toHaveLength(90);
    expect(wide.range).toMatchObject({ to: '2026-10-24', days: 90 });
    expect(wide.byDay[0]!.date).toBe(wide.range.from);
  });
});

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';

function makeStore(): { store: FlowStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-'));
  return { store: new FlowStore(dir), dir };
}

describe('FlowStore accounts', () => {
  it('menyimpan akun ke flow.json 0600 tanpa secret', async () => {
    const { store, dir } = makeStore();
    const account = await store.addAccount({ label: 'Akun 1', email: 'a@b.c', profileDir: '/tmp/p1' });
    expect(account.id).toMatch(/^acc_/);
    expect(account.status).toBe('ready');
    const file = join(dir, 'flow.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('Akun 1');
    expect(raw).not.toContain('password');
  });

  it('menolak label duplikat', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    await expect(store.addAccount({ label: 'Akun 1', email: 'x@y.z' })).rejects.toThrow(/duplicate/i);
  });

  it('menandai cooldown dan melewatinya saat claim', async () => {
    const { store } = makeStore();
    const account = await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    await store.coolDown(account.id, 60_000);
    await store.createJob({ prompt: 'ombak', aspect: '9:16', durationSec: 8 });
    await expect(store.claimJob('bridge')).resolves.toBeUndefined();
  });
});

describe('FlowStore jobs', () => {
  it('claim mengambil job terlama dan menandainya running', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    const job = await store.createJob({ prompt: 'ombak senja', technique: 'dolly-in', aspect: '9:16', durationSec: 8 });
    const claimed = await store.claimJob('bridge-1');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.bridgeId).toBe('bridge-1');
    expect(claimed?.accountId).toMatch(/^acc_/);
    await expect(store.claimJob('bridge-2')).resolves.toBeUndefined();
  });

  it('complete menyimpan filePath dan menandai done', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    const job = await store.createJob({ prompt: 'p', aspect: '16:9', durationSec: 4 });
    const claimed = await store.claimJob('b');
    await store.completeJob(claimed!.id, { filePath: '/data/flow/out.mp4', bytes: 1024, provider: 'flow' });
    const [stored] = await store.listJobs();
    expect(stored.status).toBe('done');
    expect(stored.resultPath).toBe('/data/flow/out.mp4');
    expect(stored.bytes).toBe(1024);
  });

  it('fail melempar ke queued sampai maxAttempts lalu failed', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    await store.createJob({ prompt: 'p', aspect: '9:16', durationSec: 4, maxAttempts: 2 });
    const first = await store.claimJob('b');
    await store.failJob(first!.id, 'timeout');
    const second = await store.claimJob('b');
    expect(second?.attempts).toBe(1);
    await store.failJob(second!.id, 'timeout');
    const [stored] = await store.listJobs();
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('timeout');
  });

  it('mengurutkan job terbaru lebih dulu di listJobs', async () => {
    const { store } = makeStore();
    await store.addAccount({ label: 'Akun 1', email: 'a@b.c' });
    const a = await store.createJob({ prompt: 'pertama', aspect: '9:16', durationSec: 4 });
    const b = await store.createJob({ prompt: 'kedua', aspect: '9:16', durationSec: 4 });
    const jobs = await store.listJobs();
    expect(jobs.map(j => j.id)).toEqual([b.id, a.id]);
  });
});

describe('FlowStore rotation & lease', () => {
  function patchState(dir: string, mutate: (state: any) => void) {
    const file = join(dir, 'flow.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    mutate(state);
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  }

  it('memilih akun ready dengan pemakaian hari ini terendah', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const b = await store.addAccount({ label: 'B', email: 'b@x' });
    const today = new Date().toISOString().slice(0, 10);
    patchState(dir, s => { s.accounts.find((x: any) => x.id === a.id).creditsUsedToday = 3; s.accounts.find((x: any) => x.id === a.id).dayStamp = today; });
    await store.createJob({ prompt: 'p1', aspect: '9:16' });
    const job = await store.claimJob('mac');
    expect(job?.accountId).toBe(b.id);
  });

  it('pemakaian harian di-reset saat hari berganti', async () => {
    const { store, dir } = makeStore();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    patchState(dir, s => { s.accounts[0].creditsUsedToday = 5; s.accounts[0].dayStamp = '2000-01-01'; });
    await store.createJob({ prompt: 'p1', aspect: '9:16' });
    await store.claimJob('mac');
    const [account] = await store.listAccounts();
    expect(account?.id).toBe(a.id);
    expect(account?.creditsUsedToday).toBe(1);
  });

  it('job running yang lewat lease diambil ulang (bridge mati di tengah jalan)', async () => {
    const { store, dir } = makeStore();
    await store.addAccount({ label: 'A', email: 'a@x' });
    const created = await store.createJob({ prompt: 'p1', aspect: '9:16' });
    await store.claimJob('mac');
    expect(await store.claimJob('mac')).toBeUndefined();
    patchState(dir, s => { s.jobs[0].startedAtMs = Date.now() - 60 * 60_000; });
    const again = await store.claimJob('mac');
    expect(again?.id).toBe(created.id);
    expect(again?.attempts).toBe(1);
    expect(again?.error).toMatch(/lease/i);
  });
});

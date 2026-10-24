import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';

const store = () => new FlowStore(mkdtempSync(join(tmpdir(), 'nc-pstore-')));

describe('FlowStore with providers', () => {
  it('stores provider + model on a job; absent provider means flow', async () => {
    const s = store();
    const flowJob = await s.createJob({ prompt: 'ombak' });
    expect(flowJob.provider).toBeUndefined();
    const job = await s.createJob({ prompt: 'ombak', kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    expect(job).toMatchObject({ provider: 'openrouter', model: 'google/gemini-2.5-flash-image', kind: 'image', status: 'queued' });
  });

  it('rejects an openrouter job without a valid model', async () => {
    const s = store();
    await expect(s.createJob({ prompt: 'x', provider: 'openrouter' })).rejects.toThrow(/model/);
    await expect(s.createJob({ prompt: 'x', provider: 'openrouter', model: 'no spaces allowed' })).rejects.toThrow(/model/);
  });

  it('the Mac bridge never claims an openrouter job, even when it is the oldest', async () => {
    const s = store();
    await s.addAccount({ label: 'A', email: 'a@b.c' });
    const or = await s.createJob({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    const flow = await s.createJob({ prompt: 'flow clip' });
    expect((await s.claimJob('mac'))?.id).toBe(flow.id);
    expect(await s.claimJob('mac2')).toBeUndefined();
    expect((await s.getJob(or.id))?.status).toBe('queued');
  });

  it('the openrouter claim takes only openrouter jobs, needs no Flow account and spends no Flow credits', async () => {
    const s = store();
    const acc = await s.addAccount({ label: 'A', email: 'a@b.c' });
    await s.updateAccount(acc.id, { dailyCreditCap: 0 });
    await s.createJob({ prompt: 'flow clip' });
    const or = await s.createJob({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    const claimed = await s.claimJob('openrouter', { provider: 'openrouter' });
    expect(claimed).toMatchObject({ id: or.id, status: 'running', bridgeId: 'openrouter' });
    expect(claimed?.accountId).toBeUndefined();
    expect((await s.getAccount(acc.id))?.creditsUsedToday).toBe(0);
    expect(await s.claimJob('openrouter', { provider: 'openrouter' })).toBeUndefined();
  });

  it('the openrouter worker runs several jobs at once: a second claim does not requeue the first', async () => {
    const s = store();
    const a = await s.createJob({ prompt: 'or clip a', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    const b = await s.createJob({ prompt: 'or clip b', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    expect((await s.claimJob('openrouter', { provider: 'openrouter' }))?.id).toBe(a.id);
    expect((await s.claimJob('openrouter', { provider: 'openrouter' }))?.id).toBe(b.id);
    expect((await s.getJob(a.id))?.status).toBe('running');
  });

  it('completion keeps provider openrouter and records costUsd; usage counts no Flow credits for it', async () => {
    const s = store();
    const or = await s.createJob({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await s.claimJob('openrouter', { provider: 'openrouter' });
    const done = await s.completeJob(or.id, { filePath: '/x.mp4', bytes: 2048, result: { costUsd: 0.6 } });
    expect(done).toMatchObject({ status: 'done', provider: 'openrouter', result: { costUsd: 0.6 } });
    const report = await s.usage();
    expect(report.totals.done).toBe(1);
    expect(report.totals.credits).toBe(0);
  });

  it('a final failure fails the job at once; remote ids are kept for resuming', async () => {
    const s = store();
    const or = await s.createJob({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await s.claimJob('openrouter', { provider: 'openrouter' });
    await s.setRemoteId(or.id, 'gen-123');
    expect((await s.runningJobs('openrouter')).map(j => [j.id, j.remoteId])).toEqual([[or.id, 'gen-123']]);
    const failed = await s.failJob(or.id, 'Saldo OpenRouter habis', { final: true });
    expect(failed).toMatchObject({ status: 'failed', error: 'Saldo OpenRouter habis' });
    expect(await s.runningJobs('openrouter')).toEqual([]);
  });

  it('a retryable failure re-queues the job and clears its remote id', async () => {
    const s = store();
    const or = await s.createJob({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await s.claimJob('openrouter', { provider: 'openrouter' });
    await s.setRemoteId(or.id, 'gen-1');
    const again = await s.failJob(or.id, 'OpenRouter tidak bisa dihubungi');
    expect(again?.status).toBe('queued');
    expect(again?.remoteId).toBeUndefined();
  });
});

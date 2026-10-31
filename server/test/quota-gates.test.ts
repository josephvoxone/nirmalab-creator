import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { FlowGate, UNATTRIBUTED } from '../src/quota/gates.js';
import { SpendLedger } from '../src/quota/ledger.js';
import { LimitsStore } from '../src/quota/limits.js';

function make(now: () => number = Date.now) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-qg-'));
  const limits = new LimitsStore(dataDir, () => false);
  const ledger = new SpendLedger(dataDir, { limitFor: limits.resolve, now });
  const flow = new FlowStore(join(dataDir, 'flow'));
  flow.setGate(new FlowGate({ ledger, prices: { usdPerClip: async () => 0.5, usdPerImage: async () => 0.04 } }));
  return { dataDir, limits, ledger, flow };
}

describe('FlowGate', () => {
  it('a job nobody queued by name (covers, legacy projects) is counted under system:unattributed and never refused', async () => {
    const t = make();
    await t.limits.init();
    for (let i = 0; i < 5; i++) await t.flow.createJob({ prompt: 'clip', kind: 'video' });
    expect((await t.ledger.usage(UNATTRIBUTED)).flowCredits.reserved).toBe(50);
  });

  it('a Flow still or sheet costs nothing and reserves nothing; an Axcel job has no ledger kind', async () => {
    const t = make();
    await t.flow.createJob({ prompt: 'a still', kind: 'image', createdBy: 'u' });
    await t.flow.createJob({ prompt: 'a sheet', kind: 'character', createdBy: 'u' });
    await t.flow.createJob({ prompt: 'ax', kind: 'video', createdBy: 'u', provider: 'axcel', model: 'Seedance 2.0' });
    expect((await t.ledger.usage('u')).flowCredits.reserved).toBe(0);
    expect(await t.ledger.open()).toEqual([]);
  });

  it('an OpenRouter clip reserves its price; an image reserves the image price; both are visible per user', async () => {
    const t = make();
    await t.flow.createJob({ prompt: 'clip', kind: 'video', createdBy: 'u', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await t.flow.createJob({ prompt: 'still', kind: 'image', createdBy: 'u', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    expect((await t.ledger.usage('u')).openrouterUsd.reserved).toBeCloseTo(0.54, 6);
  });

  it('sweep frees the reservation of a job that does not exist (crash between reserve and write) and keeps live ones', async () => {
    let now = Date.now();
    const t = make(() => now);
    const live = await t.flow.createJob({ prompt: 'live', kind: 'video', createdBy: 'u' });
    await t.ledger.reserve({ key: 'job:job_ghost', userId: 'u', kind: 'flowCredits', amount: 10 });
    now += 11 * 60_000;
    expect(await t.ledger.sweep(FlowGate.isLive(id => t.flow.getJob(id)))).toBe(1);
    expect((await t.ledger.open()).map(o => o.key)).toEqual([`job:${live.id}`]);
  });

  it('a job whose lease expired for good (the bridge died) gives its reservation back', async () => {
    const t = make();
    await t.flow.addAccount({ label: 'A', email: 'a@x' });
    const job = await t.flow.createJob({ prompt: 'clip', kind: 'video', createdBy: 'u', maxAttempts: 1 });
    expect((await t.flow.claimJob('b1'))?.id).toBe(job.id);
    const file = join(t.dataDir, 'flow', 'flow.json');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.jobs[0].startedAtMs = Date.now() - 3 * 3_600_000;
    writeFileSync(file, JSON.stringify(state));
    await t.flow.claimJob('b2');
    expect((await t.flow.getJob(job.id))?.status).toBe('failed');
    expect((await t.ledger.usage('u')).flowCredits.reserved).toBe(0);
  });
});

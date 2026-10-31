import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditExpectation, AuditResult } from '../src/audit/vision.js';
import { FlowStore } from '../src/flow/store.js';
import { FlowGate, committedBalance, storyQuota, type BalanceSource } from '../src/quota/gates.js';
import { QuotaError } from '../src/quota/errors.js';
import { SpendLedger } from '../src/quota/ledger.js';
import { LimitsStore } from '../src/quota/limits.js';
import { StoryError, StoryService, type StoryDeps } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const OR_VIDEO = { provider: 'openrouter' as const, model: 'google/veo-3.1-fast' };
const one = (title: string): Storyboard => ({
  title, mode: 'cepat', engine: { video: OR_VIDEO },
  shots: [{ id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Satu.' }]
} as Storyboard);

/** Two users, one OpenRouter balance of $1,00 that the 60 s cache keeps showing, a clip that costs $0,60. */
function setup(options: { remaining?: number; price?: number; audit?: StoryDeps['audit'] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-orr-'));
  const limits = new LimitsStore(dataDir, () => false);
  const ledger = new SpendLedger(dataDir, { limitFor: limits.resolve });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const snapshot = { remaining: options.remaining ?? 1.0, at: Date.now() - 5_000 };
  const source: BalanceSource = { balance: async () => ({ usedUsd: 0, limitUsd: 5, remainingUsd: snapshot.remaining }), fetchedAtMs: () => snapshot.at };
  const price = options.price ?? 0.6;
  flow.setGate(new FlowGate({ ledger, prices: { usdPerClip: async () => price, usdPerImage: async () => 0.04 }, balance: source }));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)),
    openRouter: { usdPerClip: async () => price, balance: committedBalance(ledger, source) },
    quota: storyQuota(ledger, limits.resolve),
    ...(options.audit ? { audit: options.audit } : {})
  });
  return { dataDir, limits, ledger, flow, service, snapshot };
}

describe('T5b OpenRouter balance: the cache window no longer lets two users spend the same dollars', () => {
  it('two users render at the same moment, balance 1,00, each needs 0,60: exactly one goes through', async () => {
    const t = setup();
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    const results = await Promise.allSettled([t.service.render(a.id), t.service.render(b.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!.reason;
    expect(refused instanceof QuotaError || refused instanceof StoryError).toBe(true);
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('one after the other inside the cache window: the second sees the first one\'s reservation and is refused with the balance message', async () => {
    const t = setup();
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    await t.service.render(a.id);
    const refused = await t.service.render(b.id).catch(e => e as StoryError);
    expect(refused).toBeInstanceOf(StoryError);
    expect(refused.message).toBe('Butuh ±$0,60, saldo OpenRouter $0,40');
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('a job that finished for $0,50 keeps counting until a newer balance snapshot exists', async () => {
    const t = setup();
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    await t.service.render(a.id);
    const [job] = await t.flow.listJobs();
    mkdirSync(join(t.dataDir, 'flow', 'clips'), { recursive: true });
    await t.flow.completeJob(job!.id, { filePath: join(t.dataDir, 'flow', 'clips', 'x.mp4'), bytes: 9999, provider: 'openrouter', result: { costUsd: 0.5 } });
    expect((await t.ledger.usage('ua')).openrouterUsd).toMatchObject({ day: 0.5, reserved: 0 });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    await expect(t.service.render(b.id)).rejects.toBeInstanceOf(StoryError); // 1,00 - 0,50 < 0,60
    t.snapshot.at = Date.now() + 1; t.snapshot.remaining = 0.5; // OpenRouter now shows the real balance
    await expect(t.service.render(b.id)).rejects.toBeInstanceOf(StoryError); // 0,50 < 0,60: refused for the honest reason
    t.snapshot.remaining = 4.5; // topped up
    await t.service.render(b.id);
    expect(await t.flow.listJobs()).toHaveLength(2);
  });

  it('a failed job gives its dollars back to the next one', async () => {
    const t = setup();
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    await t.service.render(a.id);
    const [job] = await t.flow.listJobs();
    await t.flow.failJob(job!.id, 'rejected', { final: true });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    await t.service.render(b.id);
    expect(await t.flow.listJobs()).toHaveLength(2);
  });

  it('force: the user who accepts going past the known balance is not stopped by it (as before)', async () => {
    const t = setup();
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    await t.service.render(a.id);
    await t.service.render(b.id, { force: true });
    expect(await t.flow.listJobs()).toHaveLength(2);
  });

  it('an unknown price reserves nothing and refuses nothing', async () => {
    const t = setup({ price: 0 });
    const a = await t.service.create(one('A'), { createdBy: 'ua' });
    await t.service.render(a.id);
    expect((await t.ledger.usage('ua')).openrouterUsd.reserved).toBe(0);
  });

  it('a per-user OpenRouter limit set by an admin stops that user, not the others', async () => {
    const t = setup({ remaining: 50 });
    await t.limits.set('ua', { openrouterUsd: { perDay: 1 } });
    const a1 = await t.service.create(one('A1'), { createdBy: 'ua' });
    const a2 = await t.service.create(one('A2'), { createdBy: 'ua' });
    const b = await t.service.create(one('B'), { createdBy: 'ub' });
    await t.service.render(a1.id);
    const refused = await t.service.render(a2.id).catch(e => e as QuotaError);
    expect(refused).toBeInstanceOf(QuotaError);
    expect(refused.message).toBe('Batas saldo OpenRouter harianmu tercapai: terpakai ±$0.60 dari $1.00; pekerjaan ini butuh ±$0.60.');
    await t.service.render(b.id);
    expect(await t.flow.listJobs()).toHaveLength(2);
  });
});

describe('T5b vision audit is OpenRouter money of the project owner', () => {
  const konsisten = (): Storyboard => ({ title: 'Audit', mode: 'cepat', shots: [{ id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Satu.' }] } as Storyboard);
  function auditDeps() {
    const calls: unknown[] = [];
    const deps: NonNullable<StoryDeps['audit']> = {
      model: async () => 'google/gemini-2.5-flash',
      run: async (input: { images: string[]; expectation: AuditExpectation; model: string }): Promise<AuditResult> => {
        calls.push(input);
        return { score: 90, dimensions: { sceneMatch: 90, actionMatch: 90, moodMatch: 90, composition: 90 }, issues: [], reasoning: 'ok', repair: '', costUsd: 0.0012 };
      },
      frames: async (_clip: string, dir: string, shotId: string) => {
        const files = [1, 2, 3].map(i => join(dir, `audit-${shotId}-${i}.png`));
        files.forEach(f => writeFileSync(f, Buffer.alloc(100, 1)));
        return files;
      }
    };
    return { deps, calls };
  }
  async function renderAndCollect(t: ReturnType<typeof setup>, createdBy: string) {
    const story = await t.service.create(konsisten(), { createdBy });
    await t.service.render(story.id);
    const dir = join(t.dataDir, 'flow', 'clips'); mkdirSync(dir, { recursive: true });
    for (const job of (await t.flow.listJobs()).filter(j => j.status === 'queued')) {
      const file = join(dir, `${job.id}.mp4`); writeFileSync(file, Buffer.alloc(20_000, 3));
      await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000 });
    }
    await t.service.reconcile(story.id);
    return (await t.service.get(story.id))!;
  }

  it('no limit: the audit runs and its real cost is counted for the owner', async () => {
    const fake = auditDeps();
    const t = setup({ audit: fake.deps, remaining: 50 });
    const record = await renderAndCollect(t, 'ua');
    expect(fake.calls).toHaveLength(1);
    expect(record.shots[0]!.audit?.score).toBe(90);
    expect((await t.ledger.usage('ua')).openrouterUsd.day).toBeCloseTo(0.0012, 6);
  });

  it('owner over an OpenRouter limit: the audit is skipped (no provider call), the log says why, the clip is untouched', async () => {
    const fake = auditDeps();
    const t = setup({ audit: fake.deps, remaining: 50 });
    await t.limits.set('ua', { openrouterUsd: { perDay: 0.005 } });
    const record = await renderAndCollect(t, 'ua');
    expect(fake.calls).toHaveLength(0);
    expect(record.events.some(e => /Audit dilewati: Batas saldo OpenRouter harianmu tercapai/.test(e.message))).toBe(true);
    expect(record.shots[0]!.status).toBe('done');
    expect(record.shots[0]!.needsReview).toBeFalsy();
  });

  it('owner with room: the estimate is held, then replaced by the real cost', async () => {
    const fake = auditDeps();
    const t = setup({ audit: fake.deps, remaining: 50 });
    await t.limits.set('ua', { openrouterUsd: { perDay: 1 } });
    await renderAndCollect(t, 'ua');
    const usage = (await t.ledger.usage('ua')).openrouterUsd;
    expect(usage.reserved).toBe(0);
    expect(usage.day).toBeCloseTo(0.0012, 6); // the real cost replaced the 0,01 estimate
  });
});

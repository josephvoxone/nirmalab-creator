import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendLedger } from '../src/quota/ledger.js';
import { QuotaError } from '../src/quota/errors.js';
import type { Limit } from '../src/quota/limits.js';

const DAY = 24 * 3_600_000;
// 2026-11-01 12:00 WITA (= 04:00 UTC)
const T0 = Date.parse('2026-11-01T04:00:00Z');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'quota-ledger-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function make(limit: Limit | undefined, opts: { now?: () => number; per?: Record<string, Limit | undefined> } = {}) {
  return new SpendLedger(dir, { limitFor: (userId, kind) => (opts.per?.[`${userId}:${kind}`] ?? (opts.per ? undefined : limit)), now: opts.now ?? (() => T0) });
}
const r = (key: string, amount: number, extra: Partial<{ userId: string; kind: 'elevenChars' | 'flowCredits' | 'openrouterUsd' }> = {}) =>
  ({ key, userId: 'a', kind: 'elevenChars' as const, amount, ...extra });

describe('SpendLedger.reserve', () => {
  it('twenty parallel reserve(10) against a limit of 100: exactly ten pass', async () => {
    const ledger = make({ perDay: 100 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.reserve(r(`k${i}`, 10))));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(10);
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(rejected).toHaveLength(10);
    expect(rejected.every(x => x.reason instanceof QuotaError && x.reason.code === 'QUOTA')).toBe(true);
    expect((await ledger.usage('a'))['elevenChars'].reserved).toBe(100);
  });

  it('same key twice is counted once (resume / HTTP retry)', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.reserve(r('dub:s:1:h', 60));
    await ledger.reserve(r('dub:s:1:h', 60));
    expect((await ledger.usage('a'))['elevenChars'].reserved).toBe(60);
  });

  it('the error says which kind, window, limit, used and amount', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.reserve(r('x', 90));
    const error = await ledger.reserve(r('y', 20)).catch(e => e as QuotaError);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ kind: 'elevenChars', window: 'day', limit: 100, used: 90, amount: 20 });
    expect(error.message).toBe('Batas dubbing hari ini habis: terpakai 90 dari 100 karakter; dubbing ini 20 karakter. Coba lagi besok atau persingkat teksnya.');
    // the day resets at 00:00 WITA
    expect(error.resetAtMs).toBe(Date.parse('2026-11-01T16:00:00Z'));
  });

  it('commit and release do the arithmetic; release frees the room, commit keeps it used', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.reserve(r('a1', 40));
    await ledger.reserve(r('a2', 40));
    await ledger.release('a1');
    await ledger.commit('a2', 35); // the provider billed less than reserved
    const u = (await ledger.usage('a'))['elevenChars'];
    expect(u).toMatchObject({ day: 35, d30: 35, reserved: 0 });
    await ledger.release('a2'); // releasing a committed key is a no-op
    expect((await ledger.usage('a'))['elevenChars'].day).toBe(35);
    await ledger.reserve(r('a3', 65)); // 35 + 65 = 100 fits exactly
    await expect(ledger.reserve(r('a4', 1))).rejects.toBeInstanceOf(QuotaError);
  });

  it('a committed key does not block a later, new operation with the same key (force re-render pays again)', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.reserve(r('same', 10));
    await ledger.commit('same');
    await ledger.reserve(r('same', 10));
    await ledger.commit('same');
    expect((await ledger.usage('a'))['elevenChars'].day).toBe(20);
  });

  it('day and 30-day windows roll over with the injected clock (day = UTC+8)', async () => {
    let now = T0;
    const ledger = make({ perDay: 100, per30d: 150 }, { now: () => now });
    await ledger.reserve(r('d1', 100)); await ledger.commit('d1');
    await expect(ledger.reserve(r('d1b', 1))).rejects.toMatchObject({ window: 'day' });
    now = Date.parse('2026-11-01T16:00:01Z'); // 00:00:01 WITA next day
    await ledger.reserve(r('d2', 50)); await ledger.commit('d2');
    await expect(ledger.reserve(r('d2b', 1))).rejects.toMatchObject({ window: 'd30', limit: 150, used: 150 });
    now = T0 + 32 * DAY; // both fell out of the 30-day window (rolled-up days count whole: never more than the limit allows)
    await ledger.reserve(r('d3', 100));
    expect((await ledger.usage('a', now))['elevenChars'].d30).toBe(0);
  });

  it('30-day message says when the first slot comes back', async () => {
    const ledger = make({ per30d: 100 });
    await ledger.reserve(r('x', 100)); await ledger.commit('x');
    const error = await ledger.reserve(r('y', 5)).catch(e => e as QuotaError);
    expect(error.window).toBe('d30');
    expect(error.message).toMatch(/^Batas dubbing 30 hari terakhirmu habis \(100\/100 karakter\)\. Slot pertama kembali sekitar \d{1,2} \w+ 2026\.$/);
    expect(error.resetAtMs).toBeGreaterThan(T0 + 29 * DAY);
  });

  it('perRender caps one batch, whatever the day has left', async () => {
    const ledger = make({ perDay: 10_000, perRender: 2500 });
    const error = await ledger.reserveMany([r('s1', 1500), r('s2', 1500)]).catch(e => e as QuotaError);
    expect(error).toMatchObject({ window: 'render', limit: 2500, amount: 3000 });
    expect(error.message).toBe('Satu dubbing maksimal 2.500 karakter; yang ini 3.000. Pecah per scene.');
    expect((await ledger.usage('a'))['elevenChars'].reserved).toBe(0);
  });

  it('reserveMany is all-or-nothing', async () => {
    const ledger = make({ perDay: 100 });
    await expect(ledger.reserveMany([r('m1', 60), r('m2', 60)])).rejects.toBeInstanceOf(QuotaError);
    expect((await ledger.usage('a'))['elevenChars'].reserved).toBe(0);
    await ledger.reserveMany([r('m1', 60), r('m2', 40)]);
    expect((await ledger.usage('a'))['elevenChars'].reserved).toBe(100);
  });

  it("user A at the limit does not block user B; no limit means unlimited", async () => {
    const ledger = make(undefined, { per: { 'a:elevenChars': { perDay: 10 } } });
    await ledger.reserve(r('a1', 10));
    await expect(ledger.reserve(r('a2', 1))).rejects.toBeInstanceOf(QuotaError);
    await ledger.reserve(r('b1', 1_000_000, { userId: 'b' }));
    await ledger.reserve(r('a3', 1_000_000, { kind: 'flowCredits' }));
    expect((await ledger.usage('b'))['elevenChars'].reserved).toBe(1_000_000);
  });

  it('amount 0 never fails, even when the user is over a lowered limit', async () => {
    const ledger = make({ perDay: 10 });
    await ledger.record({ key: 'old', userId: 'a', kind: 'elevenChars', amount: 50 });
    await ledger.reserve(r('free', 0));
  });

  it('survives a restart: reservations and commits are on disk (0600), idempotency holds, sweep frees orphans', async () => {
    const first = make({ perDay: 100 });
    await first.reserve(r('keep', 30)); await first.reserve(r('orphan', 30)); await first.reserve(r('done', 20)); await first.commit('done');
    expect(((await stat(join(dir, 'quota', 'ledger.json'))).mode & 0o777)).toBe(0o600);
    let now = T0 + 11 * 60_000;
    const second = make({ perDay: 100 }, { now: () => now });
    expect((await second.usage('a', now))['elevenChars']).toMatchObject({ day: 20, reserved: 60 });
    await second.reserve(r('keep', 30)); // idempotent after restart
    expect((await second.usage('a', now))['elevenChars'].reserved).toBe(60);
    const freed = await second.sweep(async key => key === 'keep');
    expect(freed).toBe(1);
    expect((await second.usage('a', now))['elevenChars']).toMatchObject({ day: 20, reserved: 30 });
    expect(JSON.parse(await readFile(join(dir, 'quota', 'ledger.json'), 'utf8')).entries.some((e: { key: string }) => e.key === 'orphan')).toBe(false);
  });

  it('sweep leaves young reservations alone (the job may not be written yet)', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.reserve(r('young', 10));
    expect(await ledger.sweep(async () => false)).toBe(0);
  });

  it('commit with a fallback records spend that had no reservation (resume of a pre-ledger dub)', async () => {
    const ledger = make({ perDay: 100 });
    await ledger.commit('dub:old', 12, { userId: 'a', kind: 'elevenChars' });
    expect((await ledger.usage('a'))['elevenChars'].day).toBe(12);
    await ledger.commit('dub:unknown'); // unknown key, no fallback: nothing happens
  });

  it('openrouter ceiling: balance minus open reservations of everybody, minus spend since the snapshot', async () => {
    const ledger = make(undefined);
    const ceiling = { remaining: 1.0, sinceMs: T0 - 1000 };
    await ledger.reserve({ ...r('u1', 0.6, { kind: 'openrouterUsd' }), ceiling });
    const error = await ledger.reserve({ ...r('u2', 0.6, { kind: 'openrouterUsd', userId: 'b' }), ceiling }).catch(e => e as QuotaError);
    expect(error).toMatchObject({ kind: 'openrouterUsd', window: 'balance' });
    expect(error.message).toMatch(/OpenRouter/);
    await ledger.commit('u1', 0.5);
    // the cached balance (1.0) still predates u1's spend: it is subtracted until a newer snapshot exists
    await expect(ledger.reserve({ ...r('u3', 0.6, { kind: 'openrouterUsd', userId: 'b' }), ceiling })).rejects.toBeInstanceOf(QuotaError);
    await ledger.reserve({ ...r('u3', 0.4, { kind: 'openrouterUsd', userId: 'b' }), ceiling });
    await ledger.reserve({ ...r('u4', 0.6, { kind: 'openrouterUsd', userId: 'b' }), ceiling: { remaining: 1.0, sinceMs: T0 + 5 } }).catch(() => undefined);
  });

  it('summary lists committed spend per user and kind over N days', async () => {
    const ledger = make(undefined);
    await ledger.record({ key: 's1', userId: 'a', kind: 'elevenChars', amount: 100 });
    await ledger.record({ key: 's2', userId: 'b', kind: 'flowCredits', amount: 10 });
    const s = await ledger.summary(7);
    expect(s.find(x => x.userId === 'a')).toMatchObject({ elevenChars: 100, flowCredits: 0 });
    expect(s.find(x => x.userId === 'b')).toMatchObject({ flowCredits: 10 });
  });

  it('old commits roll up into per-day totals without changing the window arithmetic', async () => {
    let now = T0;
    const ledger = make({ per30d: 1000 }, { now: () => now });
    await ledger.record({ key: 'r1', userId: 'a', kind: 'elevenChars', amount: 300 });
    now = T0 + 3 * DAY;
    await ledger.record({ key: 'r2', userId: 'a', kind: 'elevenChars', amount: 100 });
    const raw = JSON.parse(await readFile(join(dir, 'quota', 'ledger.json'), 'utf8'));
    expect(raw.entries.map((e: { key: string }) => e.key)).toEqual(['r2']);
    expect((await ledger.usage('a', now))['elevenChars']).toMatchObject({ day: 100, d30: 400 });
    now = T0 + 70 * DAY;
    await ledger.record({ key: 'r3', userId: 'a', kind: 'elevenChars', amount: 1 });
    const later = JSON.parse(await readFile(join(dir, 'quota', 'ledger.json'), 'utf8'));
    expect(JSON.stringify(later.rollup ?? {})).not.toContain('2026-11-01');
  });
});

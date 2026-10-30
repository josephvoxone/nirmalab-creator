import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyPool, PoolBusyError, PoolEmptyError, type PoolKey } from '../src/lib/key-pool.js';

const key = (n: number): PoolKey => ({ id: `k${n}`, label: `Kunci ${n}`, key: `sk_secret_value_number_${n}_abcdef`, source: 'store', addedAtMs: 1 });
const ok = <T>(value: T) => Promise.resolve({ ok: value } as const);

describe('KeyPool', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('is empty until keys are set, and says so', async () => {
    const pool = new KeyPool();
    await expect(pool.run(() => ok(1))).rejects.toBeInstanceOf(PoolEmptyError);
    expect(pool.size()).toBe(0);
  });

  it('round-robin: sequential calls are spread evenly over the keys', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1), key(2), key(3)]);
    const used: string[] = [];
    for (let i = 0; i < 6; i++) await pool.run(async k => { used.push(k.id); return { ok: true }; });
    expect(used).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
  });

  it('a rejected-for-rate-limit key cools down; the same call moves on to the next key and the cooled key is skipped until it is over', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1), key(2)]);
    const seen: string[] = [];
    const call = () => pool.run(async k => {
      seen.push(k.id);
      return k.id === 'k1' ? { rotate: { cooldownMs: 30_000, reason: '429' } } : { ok: k.id };
    });
    expect(await call()).toBe('k2');
    expect(seen).toEqual(['k1', 'k2']);
    seen.length = 0;
    expect(await call()).toBe('k2');
    expect(seen).toEqual(['k2']); // k1 is cooling: not even tried
    expect(pool.view().find(v => v.id === 'k1')).toMatchObject({ state: 'cooldown', reason: '429' });
    vi.setSystemTime(1_000_000 + 31_000);
    seen.length = 0;
    await call();
    expect(seen[0]).toBe('k1'); // cooldown is over: it is back in the rotation (and cools again)
  });

  it('repeated rejections back off exponentially (capped)', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1)]);
    const reject = () => pool.run(async () => ({ rotate: { cooldownMs: 10_000, reason: '429' } })).catch(e => e);
    await reject();
    const first = pool.view()[0]!.cooldownUntilMs! - Date.now();
    vi.setSystemTime(Date.now() + first + 1);
    await reject();
    const second = pool.view()[0]!.cooldownUntilMs! - Date.now();
    expect(first).toBe(10_000);
    expect(second).toBe(20_000);
    for (let i = 0; i < 12; i++) { vi.setSystemTime(Date.now() + 16 * 60_000); await reject(); }
    expect(pool.view()[0]!.cooldownUntilMs! - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it('a key the provider refuses (invalid) is reported as such and skipped', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1), key(2)]);
    await pool.run(async k => (k.id === 'k1' ? { rotate: { cooldownMs: 600_000, reason: 'ditolak (401)', invalid: true } } : { ok: 1 }));
    expect(pool.view().find(v => v.id === 'k1')).toMatchObject({ state: 'invalid', reason: 'ditolak (401)' });
    const used: string[] = [];
    for (let i = 0; i < 3; i++) await pool.run(async k => { used.push(k.id); return { ok: 1 }; });
    expect(used).toEqual(['k2', 'k2', 'k2']);
  });

  it('never runs more calls on one key than maxInFlight; the rest wait their turn instead of failing', async () => {
    const pool = new KeyPool({ maxInFlight: 1 });
    pool.setKeys([key(1), key(2)]);
    let running = 0; let peak = 0;
    const gates: Array<() => void> = [];
    const task = (n: number) => pool.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise<void>(r => gates.push(r));
      running--;
      return { ok: n };
    });
    const all = [task(1), task(2), task(3), task(4)];
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toBe(2); // 2 keys x 1 slot
    gates.shift()!(); await vi.advanceTimersByTimeAsync(0);
    expect(running).toBe(2); // a slot freed -> the third started
    while (gates.length) { gates.shift()!(); await vi.advanceTimersByTimeAsync(0); }
    expect(await Promise.all(all)).toEqual([1, 2, 3, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('when every key is cooling it waits for the earliest one, and gives up with the wait time once the deadline passes', async () => {
    const pool = new KeyPool({ waitTimeoutMs: 5_000 });
    pool.setKeys([key(1)]);
    await pool.run(async () => ({ rotate: { cooldownMs: 3_000, reason: '429' } })).catch(() => undefined);
    // cools for 3 s < 5 s deadline: the next call waits and then succeeds
    const waiting = pool.run(async () => ({ ok: 'later' }));
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await waiting).toBe('later');
    // cools for 60 s > 5 s deadline: it must fail fast with a retry hint, not hang
    pool.setKeys([key(2)]);
    await pool.run(async () => ({ rotate: { cooldownMs: 60_000, reason: '429' } })).catch(() => undefined);
    const stuck = pool.run(async () => ({ ok: 1 })).catch(e => e);
    await vi.advanceTimersByTimeAsync(6_000);
    const err = await stuck;
    expect(err).toBeInstanceOf(PoolBusyError);
    expect((err as PoolBusyError).retryAfterMs).toBeGreaterThan(40_000);
  });

  it('a caller error is thrown as is: no rotation, the key is not penalised', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1), key(2)]);
    await expect(pool.run(async () => ({ fail: new Error('teks kosong') }))).rejects.toThrow('teks kosong');
    expect(pool.view().every(v => v.state === 'ready' && v.failures === 0)).toBe(true);
  });

  it('a thrown exception releases the slot (no leak)', async () => {
    const pool = new KeyPool({ maxInFlight: 1 });
    pool.setKeys([key(1)]);
    await expect(pool.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pool.view()[0]!.inFlight).toBe(0);
    expect(await pool.run(async () => ({ ok: 'fine' }))).toBe('fine');
  });

  it('view() never contains the secret, only the last 4 characters', () => {
    const pool = new KeyPool();
    pool.setKeys([key(7)]);
    const text = JSON.stringify(pool.view());
    expect(text).not.toContain('sk_secret_value');
    expect(pool.view()[0]!.keyHint).toBe('••••cdef');
  });

  it('setKeys keeps the statistics of keys that stay and forgets the removed ones', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1), key(2)]);
    await pool.run(async () => ({ ok: 1 }));
    await pool.run(async () => ({ ok: 1 }));
    pool.setKeys([key(2), key(3)]);
    expect(pool.view().map(v => [v.id, v.uses])).toEqual([['k2', 1], ['k3', 0]]);
  });

  it('counts uses and the last use per key', async () => {
    const pool = new KeyPool();
    pool.setKeys([key(1)]);
    await pool.run(async () => ({ ok: 1 }));
    expect(pool.view()[0]).toMatchObject({ uses: 1, lastUsedAtMs: 1_000_000 });
  });
});

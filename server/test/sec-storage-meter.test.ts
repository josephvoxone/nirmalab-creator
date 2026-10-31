import { describe, expect, it, vi } from 'vitest';
import { StorageMeter } from '../src/media/storage-meter.js';
import * as storage from '../src/media/storage.js';

vi.mock('../src/media/storage.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/media/storage.js')>();
  return { ...mod, measureStorage: vi.fn() };
});
const measure = vi.mocked(storage.measureStorage);
const report = (usedBytes: number): storage.StorageReport => ({ usedBytes, byArea: { stories: usedBytes, clips: 0, cache: 0, covers: 0, other: 0 }, diskFreeBytes: 1 });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe('StorageMeter', () => {
  it('serves the cached report inside the TTL and measures again after it', async () => {
    measure.mockReset().mockResolvedValueOnce(report(1)).mockResolvedValueOnce(report(2));
    let clock = 1000;
    const meter = new StorageMeter('/d', { ttlMs: 60_000, now: () => clock });
    expect((await meter.get()).usedBytes).toBe(1);
    clock += 59_999;
    expect((await meter.get()).usedBytes).toBe(1);
    clock += 2;
    expect((await meter.get()).usedBytes).toBe(2);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share the scan in flight', async () => {
    const d = deferred<storage.StorageReport>();
    measure.mockReset().mockReturnValueOnce(d.promise);
    const meter = new StorageMeter('/d');
    const all = Promise.all([meter.get(), meter.get(), meter.get()]);
    d.resolve(report(5));
    expect((await all).map(r => r.usedBytes)).toEqual([5, 5, 5]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('a scan that was running when the janitor finished is not cached, and later callers do not join it', async () => {
    const stale = deferred<storage.StorageReport>();
    measure.mockReset().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(report(10));
    const meter = new StorageMeter('/d');
    const running = meter.get();
    meter.invalidate();                                   // cleanup finished while the scan was still walking
    expect((await meter.get()).usedBytes).toBe(10);       // new scan, not the pre-cleanup one
    stale.resolve(report(999));
    expect((await running).usedBytes).toBe(999);          // its own caller still gets an answer…
    expect((await meter.get()).usedBytes).toBe(10);       // …but it never replaced the fresh figure
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('errors are not cached: the next call tries again', async () => {
    measure.mockReset().mockRejectedValueOnce(new Error('io')).mockResolvedValueOnce(report(3));
    const meter = new StorageMeter('/d');
    await expect(meter.get()).rejects.toThrow('io');
    expect((await meter.get()).usedBytes).toBe(3);
  });

  it('force measures even inside the TTL and refreshes the cache', async () => {
    measure.mockReset().mockResolvedValueOnce(report(1)).mockResolvedValueOnce(report(7));
    const meter = new StorageMeter('/d');
    await meter.get();
    expect((await meter.get(true)).usedBytes).toBe(7);
    expect((await meter.get()).usedBytes).toBe(7);
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

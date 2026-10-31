/**
 * Cached `measureStorage` for the sidebar quota. The scan walks every file of the data volume, and
 * GET /api/quota is polled by every signed-in user every 60 s, so the cost used to grow with the number of
 * people online. Now: one scan per TTL window no matter how many callers, concurrent callers share the scan in
 * flight, errors are never cached, and `invalidate()` (after the storage janitor) also discards a scan that
 * was already running — its figure was taken before the cleanup and must not be stored.
 */
import { measureStorage, type StorageReport } from './storage.js';

export const STORAGE_CACHE_TTL_MS = 60_000;

export class StorageMeter {
  private entry?: { at: number; value: StorageReport };
  private inflight?: { gen: number; promise: Promise<StorageReport> };
  private gen = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly dataDir: string, options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? STORAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The cached report, or a scan (shared with any other caller already waiting for one). `force` always scans. */
  get(force = false): Promise<StorageReport> {
    if (!force) {
      if (this.entry && this.now() - this.entry.at < this.ttlMs) return Promise.resolve(this.entry.value);
      if (this.inflight && this.inflight.gen === this.gen) return this.inflight.promise;
    }
    const gen = this.gen;
    const promise: Promise<StorageReport> = measureStorage(this.dataDir).then(
      value => {
        if (gen === this.gen) this.entry = { at: this.now(), value };
        if (this.inflight?.promise === promise) this.inflight = undefined;
        return value;
      },
      error => {
        if (this.inflight?.promise === promise) this.inflight = undefined;
        throw error;
      }
    );
    this.inflight = { gen, promise };
    return promise;
  }

  /** Forget the figure (and any scan in flight): the next `get()` measures again. */
  invalidate(): void {
    this.gen += 1;
    this.entry = undefined;
    this.inflight = undefined;
  }
}

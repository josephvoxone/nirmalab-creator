/**
 * A work queue with a global concurrency limit and round-robin turns between owners (users).
 *
 * Why: assembling a video takes ~1.2 GB and several cores; dubbing a story makes dozens of provider calls.
 * Unbounded, a hundred users clicking at once exhaust RAM (one ffmpeg was already OOM-killed on this VPS) or the
 * API quota. Here at most `concurrency` tasks run; the rest wait their turn; an owner with a big backlog does not
 * make another owner wait for all of it; `maxWaiting` refuses work instead of queueing without bound.
 */
export class QueueFullError extends Error {
  constructor(readonly waiting: number) { super(`Antrean penuh (${waiting} menunggu). Coba lagi beberapa saat lagi.`); this.name = 'QueueFullError'; }
}

type Task = {
  owner: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onPosition: ((position: number, total: number) => void) | undefined;
  last?: string;
  detach?: () => void;
};

export type FairQueueStats = { running: number; waiting: number; concurrency: number; owners: number };

export class FairQueue {
  private concurrency: number;
  private readonly maxWaiting: number;
  private running = 0;
  /** owner → their waiting tasks (FIFO). */
  private readonly lanes = new Map<string, Task[]>();
  /** Owners in turn order; the head is served next. */
  private ring: string[] = [];

  constructor(options: { concurrency: number; maxWaiting?: number }) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.maxWaiting = options.maxWaiting ?? Infinity;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }

  stats(): FairQueueStats {
    return { running: this.running, waiting: this.waiting(), concurrency: this.concurrency, owners: this.lanes.size };
  }

  run<T>(owner: string, task: () => Promise<T>, options: { signal?: AbortSignal; onPosition?: (position: number, total: number) => void } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (this.running >= this.concurrency && this.waiting() >= this.maxWaiting) return Promise.reject(new QueueFullError(this.waiting()));
    return new Promise<T>((resolve, reject) => {
      const entry: Task = { owner, run: task, resolve: resolve as (v: unknown) => void, reject, onPosition: options.onPosition };
      if (options.signal) {
        const onAbort = () => { if (this.remove(entry)) { reject(abortError()); this.notify(); } };
        options.signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => options.signal!.removeEventListener('abort', onAbort);
      }
      const lane = this.lanes.get(owner);
      if (lane) lane.push(entry);
      else { this.lanes.set(owner, [entry]); this.ring.push(owner); }
      this.pump();
      this.notify();
    });
  }

  private waiting(): number {
    let n = 0;
    for (const lane of this.lanes.values()) n += lane.length;
    return n;
  }

  private remove(entry: Task): boolean {
    const lane = this.lanes.get(entry.owner);
    const i = lane ? lane.indexOf(entry) : -1;
    if (!lane || i < 0) return false;
    lane.splice(i, 1);
    if (!lane.length) { this.lanes.delete(entry.owner); this.ring = this.ring.filter(o => o !== entry.owner); }
    entry.detach?.();
    return true;
  }

  private next(): Task | undefined {
    const owner = this.ring[0];
    if (owner === undefined) return undefined;
    const lane = this.lanes.get(owner)!;
    const entry = lane.shift()!;
    this.ring.shift();
    if (lane.length) this.ring.push(owner); // back of the ring: the next owner is served before this one again
    else this.lanes.delete(owner);
    return entry;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const entry = this.next();
      if (!entry) break;
      entry.detach?.();
      this.running++;
      entry.run().then(entry.resolve, entry.reject).finally(() => { this.running--; this.pump(); this.notify(); });
    }
  }

  /** Tell every waiting task that wants to know where it stands, when that changed. */
  private notify(): void {
    const order: Task[] = [];
    const cursors = new Map<string, number>();
    const ring = [...this.ring];
    // dispatch order = rounds over the ring, one task per owner per round
    for (let more = true; more;) {
      more = false;
      for (const owner of ring) {
        const lane = this.lanes.get(owner)!;
        const i = cursors.get(owner) ?? 0;
        if (i < lane.length) { order.push(lane[i]!); cursors.set(owner, i + 1); more = true; }
      }
    }
    order.forEach((task, i) => {
      if (!task.onPosition) return;
      const key = `${i + 1}/${order.length}`;
      if (key === task.last) return;
      task.last = key;
      try { task.onPosition(i + 1, order.length); } catch { /* a listener must not break the queue */ }
    });
  }
}

function abortError(): Error {
  const e = new Error('Dibatalkan');
  e.name = 'AbortError';
  return e;
}

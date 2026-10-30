/**
 * A pool of API keys for one provider: round-robin, per-key cooldown, a cap on simultaneous calls per key
 * and a short wait queue.
 *
 * Why: with many users one key hits its rate limit / concurrency limit first. The pool spreads calls over the
 * keys, takes a key out of rotation when the provider pushes back (429, refused, quota) and — instead of failing
 * the user — makes the call wait for a free slot or the end of the earliest cooldown (bounded by `waitTimeoutMs`).
 *
 * `run(fn)`: `fn` makes ONE provider call with the key it is given and returns a verdict:
 *   { ok }            the result
 *   { rotate }        this key cannot serve it (429 / 401 / quota): cool it down and retry on another key
 *   { fail }          the request itself is wrong: thrown as is, the key is not blamed
 * A key is tried at most once per `run`. Secrets never leave this class except into `fn`; `view()` is safe to send.
 */
export type PoolKey = { id: string; label: string; key: string; source: 'store' | 'env'; addedAtMs: number };
export type Verdict<T> = { ok: T } | { rotate: { cooldownMs: number; reason: string; invalid?: boolean; /** Only the `scope` of this call (e.g. one model's quota) is limited, not the whole key. */ scoped?: boolean } } | { fail: Error };
export type KeyState = 'ready' | 'busy' | 'cooldown' | 'invalid';
export type KeyView = {
  id: string; label: string; keyHint: string; source: 'store' | 'env'; state: KeyState;
  inFlight: number; uses: number; failures: number; cooldownUntilMs?: number; reason?: string; lastUsedAtMs?: number;
  /** Scopes (models) this key is limited for right now, while still ready for the rest. */
  limited?: string[];
};

export class PoolEmptyError extends Error {
  constructor() { super('Belum ada API key di pool.'); this.name = 'PoolEmptyError'; }
}
export class PoolBusyError extends Error {
  constructor(readonly retryAfterMs: number, why: string) { super(why); this.name = 'PoolBusyError'; }
}

type Slot = PoolKey & { inFlight: number; uses: number; failures: number; streak: number; until: number; invalid: boolean; scoped: Map<string, number>; reason?: string; lastUsedAtMs?: number };

const MAX_COOLDOWN_MS = 15 * 60_000;

export class KeyPool {
  private slots: Slot[] = [];
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private readonly maxInFlight: number;
  private readonly waitTimeoutMs: number;

  constructor(options: { maxInFlight?: number; waitTimeoutMs?: number } = {}) {
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 2);
    this.waitTimeoutMs = options.waitTimeoutMs ?? 60_000;
  }

  size(): number { return this.slots.length; }

  /** Replace the key list; statistics of keys that stay are kept. */
  setKeys(keys: PoolKey[]): void {
    const old = new Map(this.slots.map(s => [s.id, s]));
    this.slots = keys.map(k => {
      const before = old.get(k.id);
      return before && before.key === k.key
        ? { ...before, label: k.label, source: k.source }
        : { ...k, inFlight: 0, uses: 0, failures: 0, streak: 0, until: 0, invalid: false, scoped: new Map<string, number>() };
    });
    this.cursor = 0;
    this.wake();
  }

  view(): KeyView[] {
    const now = Date.now();
    return this.slots.map(s => {
      const cooling = s.until > now;
      const state: KeyState = cooling ? (s.invalid ? 'invalid' : 'cooldown') : s.inFlight >= this.maxInFlight ? 'busy' : 'ready';
      const limited = [...s.scoped].filter(([, until]) => until > now).map(([scope]) => scope);
      return {
        id: s.id, label: s.label, keyHint: `••••${s.key.slice(-4)}`, source: s.source, state, inFlight: s.inFlight,
        uses: s.uses, failures: s.failures,
        ...(cooling ? { cooldownUntilMs: s.until, ...(s.reason ? { reason: s.reason } : {}) } : {}),
        ...(s.lastUsedAtMs !== undefined ? { lastUsedAtMs: s.lastUsedAtMs } : {}),
        ...(limited.length ? { limited } : {})
      };
    });
  }

  async run<T>(fn: (key: PoolKey) => Promise<Verdict<T>>, options: { scope?: string } = {}): Promise<T> {
    const scope = options.scope;
    if (!this.slots.length) throw new PoolEmptyError();
    const tried = new Set<string>();
    const deadline = Date.now() + this.waitTimeoutMs;
    for (;;) {
      const slot = this.acquire(tried, scope);
      if (!slot) {
        const untried = this.slots.filter(s => !tried.has(s.id));
        if (!untried.length) throw new PoolBusyError(this.soonestMs(this.slots, scope), 'Semua API key di pool menolak permintaan ini.');
        const now = Date.now();
        const left = deadline - now;
        const soonest = this.soonestMs(untried, scope);
        if (left <= 0 || (soonest > left && !untried.some(s => this.freeAt(s, scope) <= now))) {
          throw new PoolBusyError(soonest, 'Semua API key sedang di-cooldown atau penuh; coba lagi sebentar.');
        }
        await this.waitForChange(Math.min(left, soonest > 0 ? soonest : left));
        continue;
      }
      let verdict: Verdict<T>;
      try {
        verdict = await fn({ id: slot.id, label: slot.label, key: slot.key, source: slot.source, addedAtMs: slot.addedAtMs });
      } catch (error) {
        this.release(slot);
        throw error;
      }
      this.release(slot);
      if ('ok' in verdict) { slot.uses++; slot.streak = 0; slot.lastUsedAtMs = Date.now(); return verdict.ok; }
      if ('fail' in verdict) throw verdict.fail;
      slot.failures++;
      slot.streak++;
      const until = Date.now() + Math.min(MAX_COOLDOWN_MS, verdict.rotate.cooldownMs * 2 ** (slot.streak - 1));
      if (verdict.rotate.scoped && scope) slot.scoped.set(scope, until);
      else { slot.until = until; slot.invalid = verdict.rotate.invalid === true; slot.reason = verdict.rotate.reason; }
      tried.add(slot.id);
    }
  }

  private acquire(tried: Set<string>, scope?: string): Slot | undefined {
    const now = Date.now();
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const s = this.slots[idx]!;
      if (tried.has(s.id) || this.freeAt(s, scope) > now || s.inFlight >= this.maxInFlight) continue;
      this.cursor = (idx + 1) % n;
      s.inFlight++;
      return s;
    }
    return undefined;
  }

  private release(slot: Slot): void {
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    this.wake();
  }

  /** When this key can take a call for `scope` (a cooldown of the whole key or of that scope, whichever ends later). */
  private freeAt(s: Slot, scope?: string): number {
    return Math.max(s.until, scope ? s.scoped.get(scope) ?? 0 : 0);
  }

  /** Ms until the first of `slots` can take a call (0 = one is only busy, not cooling). */
  private soonestMs(slots: Slot[], scope?: string): number {
    const now = Date.now();
    const waits = slots.map(s => Math.max(0, this.freeAt(s, scope) - now));
    return waits.length ? Math.min(...waits) : 0;
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); const i = this.waiters.indexOf(done); if (i >= 0) this.waiters.splice(i, 1); resolve(); };
      const timer = setTimeout(done, Math.max(1, ms));
      this.waiters.push(done);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}

/**
 * Spending ledger per user: reserve -> commit -> release, atomic and idempotent per operation key.
 * Pattern of `audit/ledger.ts` (one promise queue, 0600 private JSON at `<dataDir>/quota/ledger.json`), keyed by userId.
 *
 *  - `reserve` runs in the queue: it counts committed spend of the window + every open reservation + the new amount,
 *    throws `QuotaError` over the limit and otherwise writes the reservation BEFORE returning. Two clicks at once cannot
 *    both pass the last bit of a limit. Nothing in here touches the network (callers fetch prices/balances first).
 *  - The same key twice is one reservation (restart, resume, HTTP retry). A committed key does not block a NEW operation.
 *  - Days are Asia/Makassar (UTC+8, like the Flow accounts); the second window is the last 30 x 24 h.
 *  - One process only (like every store in this app).
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import { QuotaError, type QuotaKind, type QuotaWindow } from './errors.js';
import { QUOTA_KINDS, limitNumber, type LimitResolver } from './limits.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WITA = 8 * HOUR;
/** Exact committed entries older than this are folded into per-day totals. */
const ROLLUP_AFTER_MS = 2 * DAY;
const KEEP_MS = 62 * DAY;
/** A reservation younger than this is never swept: the job/dub it belongs to may not be written yet. */
const SWEEP_GRACE_MS = 10 * 60_000;
const EPS = 1e-9;

export const wita = (ms: number): string => new Date(ms + WITA).toISOString().slice(0, 10);
const dayStart = (key: string): number => Date.parse(`${key}T00:00:00Z`) - WITA;

type Entry = { key: string; userId: string; kind: QuotaKind; amount: number; state: 'reserved' | 'committed'; atMs: number; doneAtMs?: number; meta?: Record<string, unknown> };
type Rollup = Record<string, Record<string, Partial<Record<QuotaKind, number>>>>; // userId -> day -> kind -> amount
type Stored = { version: 1; entries: Entry[]; rollup: Rollup };

export type Reservation = { key: string; userId: string; kind: QuotaKind; amount: number; meta?: Record<string, unknown>;
  /** Shared OpenRouter balance: the reservation must also fit `remaining` minus everything open or spent since `sinceMs`. */
  ceiling?: { remaining: number; sinceMs: number } };
export type Usage = Record<QuotaKind, { day: number; d30: number; reserved: number }>;

const clean = (n: number) => Math.round(n * 1e6) / 1e6;

export type LedgerOptions = { limitFor: LimitResolver; now?: () => number };

export class SpendLedger {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private state: Stored | undefined;
  private readonly now: () => number;
  private readonly limitFor: LimitResolver;

  constructor(dataDir: string, options: LedgerOptions) {
    this.path = join(dataDir, 'quota', 'ledger.json');
    this.limitFor = options.limitFor;
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------------ storage

  private async load(): Promise<Stored> {
    if (this.state) return this.state;
    const empty: Stored = { version: 1, entries: [], rollup: {} };
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Partial<Stored> | undefined;
      const entries = Array.isArray(raw?.entries) ? raw!.entries.filter(e => e && typeof e.key === 'string' && typeof e.userId === 'string' && (QUOTA_KINDS as readonly string[]).includes(e.kind) && Number.isFinite(e.amount)) : [];
      this.state = { version: 1, entries, rollup: raw?.rollup && typeof raw.rollup === 'object' ? raw.rollup : {} };
    } catch { this.state = empty; }
    return this.state;
  }

  /** One at a time, in order; the state is written (atomically) before the caller continues. */
  private run<T>(work: (s: Stored) => T | Promise<T>, options: { write?: boolean } = {}): Promise<T> {
    const next = this.queue.then(async () => {
      const s = await this.load();
      const before = options.write === false ? '' : JSON.stringify(s);
      let out: T;
      try { out = await work(s); } catch (error) {
        // A failed reserve changed nothing in memory (checks happen before mutation), so there is nothing to undo.
        throw error;
      }
      if (options.write !== false) {
        this.compact(s);
        if (JSON.stringify(s) !== before) {
          try { await writePrivateJsonFile(this.path, s); } catch (error) { this.state = undefined; throw error; }
        }
      }
      return out;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Folds old committed entries into per-day totals; drops what is older than the retention. */
  private compact(s: Stored): void {
    const now = this.now();
    const keep: Entry[] = [];
    for (const e of s.entries) {
      if (e.state === 'committed' && (e.doneAtMs ?? e.atMs) < now - ROLLUP_AFTER_MS) {
        const day = wita(e.doneAtMs ?? e.atMs);
        const bucket = ((s.rollup[e.userId] ??= {})[day] ??= {});
        bucket[e.kind] = clean((bucket[e.kind] ?? 0) + e.amount);
      } else keep.push(e);
    }
    s.entries = keep;
    for (const [userId, days] of Object.entries(s.rollup)) {
      for (const day of Object.keys(days)) if (dayStart(day) + DAY < now - KEEP_MS) delete days[day];
      if (!Object.keys(days).length) delete s.rollup[userId];
    }
  }

  // ------------------------------------------------------------------ arithmetic

  private spent(s: Stored, userId: string, kind: QuotaKind, now: number): { day: number; d30: number; reserved: number; firstD30Ms?: number } {
    const today = wita(now);
    const from30 = now - 30 * DAY;
    let day = 0; let d30 = 0; let reserved = 0; let first: number | undefined;
    const note = (ms: number) => { first = first === undefined ? ms : Math.min(first, ms); };
    for (const e of s.entries) {
      if (e.userId !== userId || e.kind !== kind) continue;
      if (e.state === 'reserved') { reserved += e.amount; continue; }
      const at = e.doneAtMs ?? e.atMs;
      if (wita(at) === today) day += e.amount;
      if (at > from30) { d30 += e.amount; note(at); }
    }
    for (const [d, kinds] of Object.entries(s.rollup[userId] ?? {})) {
      const amount = kinds[kind] ?? 0;
      if (!amount) continue;
      if (d === today) day += amount;
      if (dayStart(d) + DAY > from30) { d30 += amount; note(dayStart(d)); }
    }
    return { day: clean(day), d30: clean(d30), reserved: clean(reserved), ...(first === undefined ? {} : { firstD30Ms: first }) };
  }

  private check(s: Stored, batch: Reservation[], now: number): void {
    const groups = new Map<string, Reservation[]>();
    for (const r of batch) { const k = `${r.userId}\u0000${r.kind}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
    for (const items of groups.values()) {
      const { userId, kind } = items[0]!;
      const amount = clean(items.reduce((n, r) => n + r.amount, 0));
      if (amount <= 0) continue; // free work never fails, even when the user is over a lowered limit
      const limit = this.limitFor(userId, kind);
      const used = this.spent(s, userId, kind, now);
      const perRender = limitNumber(limit, 'perRender');
      if (perRender !== undefined && amount > perRender + EPS) throw new QuotaError({ kind, window: 'render', limit: perRender, used: 0, amount });
      const perDay = limitNumber(limit, 'perDay');
      if (perDay !== undefined && used.day + used.reserved + amount > perDay + EPS) {
        throw new QuotaError({ kind, window: 'day', limit: perDay, used: clean(used.day + used.reserved), amount, resetAtMs: dayStart(wita(now)) + DAY });
      }
      const per30d = limitNumber(limit, 'per30d');
      if (per30d !== undefined && used.d30 + used.reserved + amount > per30d + EPS) {
        throw new QuotaError({ kind, window: 'd30', limit: per30d, used: clean(used.d30 + used.reserved), amount, resetAtMs: (used.firstD30Ms ?? now) + 30 * DAY });
      }
    }
    for (const r of batch) {
      if (!r.ceiling || r.amount <= 0) continue;
      let used = 0;
      for (const e of s.entries) {
        if (e.kind !== r.kind) continue;
        if (e.state === 'reserved' || (e.doneAtMs ?? e.atMs) >= r.ceiling.sinceMs) used += e.amount;
      }
      // the reservations of this very batch count too (a batch is one decision)
      for (const o of batch) if (o !== r && o.kind === r.kind && o.ceiling) used += o.amount;
      if (used + r.amount > r.ceiling.remaining + EPS) throw new QuotaError({ kind: r.kind, window: 'balance', limit: r.ceiling.remaining, used: clean(used), amount: r.amount });
    }
  }

  // ------------------------------------------------------------------ operations

  /** Atomic check-then-reserve; the same key while still open is a no-op. Throws QuotaError over a limit. */
  async reserve(r: Reservation): Promise<void> { return this.reserveMany([r]); }

  /** All or nothing. A batch of one user is also checked against `perRender` as a whole. */
  async reserveMany(batch: Reservation[]): Promise<void> {
    if (!batch.length) return;
    for (const r of batch) if (!r.userId || !Number.isFinite(r.amount) || r.amount < 0) throw new Error('Reservasi kuota tidak valid');
    await this.run(s => {
      const now = this.now();
      const fresh = batch.filter(r => !s.entries.some(e => e.key === r.key && e.state === 'reserved'));
      if (!fresh.length) return;
      this.check(s, fresh, now);
      for (const r of fresh) s.entries.push({ key: r.key, userId: r.userId, kind: r.kind, amount: clean(r.amount), state: 'reserved', atMs: now, ...(r.meta ? { meta: r.meta } : {}) });
    });
  }

  /**
   * The operation finished and the provider billed: the reservation becomes spend (`actual` when the real number is
   * known). No open reservation: with `fallback` the spend is recorded anyway (billed work must be counted); without,
   * nothing happens.
   */
  async commit(key: string, actual?: number, fallback?: { userId: string; kind: QuotaKind; meta?: Record<string, unknown> }): Promise<void> {
    await this.run(s => {
      const now = this.now();
      const hit = s.entries.find(e => e.key === key && e.state === 'reserved');
      if (hit) {
        if (typeof actual === 'number' && Number.isFinite(actual) && actual >= 0) hit.amount = clean(actual);
        hit.state = 'committed'; hit.doneAtMs = now;
        return;
      }
      if (fallback && typeof actual === 'number' && Number.isFinite(actual) && actual > 0) {
        s.entries.push({ key, userId: fallback.userId, kind: fallback.kind, amount: clean(actual), state: 'committed', atMs: now, doneAtMs: now, ...(fallback.meta ? { meta: fallback.meta } : {}) });
      }
    });
  }

  /** The operation failed or was stopped before the provider billed: give the room back. Committed spend stays. */
  async release(key: string): Promise<void> {
    await this.run(s => { s.entries = s.entries.filter(e => !(e.key === key && e.state === 'reserved')); });
  }

  /** Spend that needs no limit check (an operation confirmed earlier, or a limitless user): counted, never refused. */
  async record(r: Reservation): Promise<void> {
    if (!(r.amount > 0)) return;
    await this.run(s => {
      const now = this.now();
      s.entries.push({ key: r.key, userId: r.userId, kind: r.kind, amount: clean(r.amount), state: 'committed', atMs: now, doneAtMs: now, ...(r.meta ? { meta: r.meta } : {}) });
    });
  }

  async usage(userId: string, now = this.now()): Promise<Usage> {
    return this.run(s => {
      const out = {} as Usage;
      for (const kind of QUOTA_KINDS) { const u = this.spent(s, userId, kind, now); out[kind] = { day: u.day, d30: u.d30, reserved: u.reserved }; }
      return out;
    }, { write: false });
  }

  /** Spend of every user in the last `days` days (committed only), per kind: for the admin's usage view. */
  async summary(days: number): Promise<Array<{ userId: string } & Record<QuotaKind, number>>> {
    return this.run(s => {
      const now = this.now();
      const from = now - Math.max(1, days) * DAY;
      const users = new Map<string, Record<QuotaKind, number>>();
      const row = (id: string) => { let r = users.get(id); if (!r) { r = Object.fromEntries(QUOTA_KINDS.map(k => [k, 0])) as Record<QuotaKind, number>; users.set(id, r); } return r; };
      for (const e of s.entries) if (e.state === 'committed' && (e.doneAtMs ?? e.atMs) > from) row(e.userId)[e.kind] += e.amount;
      for (const [id, byDay] of Object.entries(s.rollup)) for (const [d, kinds] of Object.entries(byDay)) if (dayStart(d) + DAY > from) for (const [k, n] of Object.entries(kinds)) row(id)[k as QuotaKind] += n ?? 0;
      return [...users.entries()].map(([userId, r]) => ({ userId, ...Object.fromEntries(QUOTA_KINDS.map(k => [k, clean(r[k])])) } as { userId: string } & Record<QuotaKind, number>));
    }, { write: false });
  }

  /** Open reservations (all users) + committed spend since `sinceMs`, of one kind: what the last balance snapshot does not know yet. */
  async inFlight(kind: QuotaKind, sinceMs: number): Promise<number> {
    return this.run(s => clean(s.entries.filter(e => e.kind === kind && (e.state === 'reserved' || (e.doneAtMs ?? e.atMs) >= sinceMs)).reduce((n, e) => n + e.amount, 0)), { write: false });
  }

  /** Keys (with kind/user) of the open reservations. */
  async open(): Promise<Array<{ key: string; userId: string; kind: QuotaKind; amount: number; atMs: number }>> {
    return this.run(s => s.entries.filter(e => e.state === 'reserved').map(({ key, userId, kind, amount, atMs }) => ({ key, userId, kind, amount, atMs })), { write: false });
  }

  /** Releases reservations whose operation no longer exists (a crash between reserve and job/dub creation). Returns how many. */
  async sweep(isLive: (key: string) => Promise<boolean>): Promise<number> {
    const now = this.now();
    const old = (await this.open()).filter(e => now - e.atMs > SWEEP_GRACE_MS);
    const dead: string[] = [];
    for (const e of old) { if (!(await isLive(e.key).catch(() => true))) dead.push(e.key); } // a failing check keeps the reservation
    if (!dead.length) return 0;
    return this.run(s => {
      const before = s.entries.length;
      s.entries = s.entries.filter(e => !(e.state === 'reserved' && dead.includes(e.key) && now - e.atMs > SWEEP_GRACE_MS));
      return before - s.entries.length;
    });
  }
}

export type { QuotaWindow };

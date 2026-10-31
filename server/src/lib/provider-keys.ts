/**
 * The API keys of one provider (ElevenLabs, Gemini): stored in `<dataDir>/providers/keypool-<provider>.json`
 * (0600), merged with keys from the server environment, and loaded into a `KeyPool`. A key is never returned
 * (only `keyHint`, the last 4 characters) and never logged.
 *
 * Gemini: a pool of up to 10 keys (round-robin). ElevenLabs: ONE active key. Sharing or rotating several accounts
 * is against ElevenLabs' terms, so there is no round-robin across accounts: a second key is refused (`SATU_KUNCI`),
 * and keys that old data or the environment hold beyond the first are DORMANT — kept (never deleted, they were paid
 * for), never loaded into the pool, never sent to the provider. An admin can swap one in (`activate`) or replace the
 * active key (`replaceActive`). Nothing here calls the network.
 *
 * File: `{ keys: [...active], dormant?: [...] }` (older files only have `keys`, possibly more than the capacity: the
 * first stay active, the rest move to `dormant` when the file is loaded).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from './private-json-file.js';
import { KeyPool, type KeyView, type PoolKey } from './key-pool.js';
import { ProviderInputError } from '../providers/config.js';

export const MAX_POOL_KEYS = 10;
export type PoolProvider = 'elevenlabs' | 'gemini';
/** Keys a provider may have ACTIVE at once. */
export const MAX_ACTIVE_KEYS: Record<PoolProvider, number> = { elevenlabs: 1, gemini: MAX_POOL_KEYS };
const ENV_VARS: Record<PoolProvider, string[]> = { elevenlabs: ['ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEYS'], gemini: ['GEMINI_API_KEYS'] };
const NAME: Record<PoolProvider, string> = { elevenlabs: 'ElevenLabs', gemini: 'Gemini' };

/** A second key for a one-key provider (HTTP 409). */
export class SingleKeyError extends ProviderInputError {
  readonly code = 'SATU_KUNCI' as const;
  constructor() { super('ElevenLabs hanya boleh satu kunci: Ketentuan Layanan melarang berbagi atau memutar beberapa akun. Pakai "Ganti kunci" untuk menggantinya.'); }
}

/** The active key comes from the server environment: change it there (HTTP 409). */
export class ManagedByEnvError extends ProviderInputError {
  readonly code = 'MANAGED_BY_ENV' as const;
  constructor() { super('Kunci aktif berasal dari environment server (ELEVENLABS_API_KEY / ELEVENLABS_API_KEYS); ubah di konfigurasi server, bukan dari sini.'); }
}

type StoredKey = { id: string; label: string; key: string; addedAtMs: number };
type Stored = { keys: StoredKey[]; dormant?: StoredKey[] };
export type DormantView = { id: string; label: string; keyHint: string; source: 'store' | 'env'; addedAtMs: number; reason: 'batas' | 'env' };

const idOf = (key: string, prefix: string) => `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
const hint = (key: string) => `••••${key.slice(-4)}`;
const validStored = (k: unknown): k is StoredKey => !!k && typeof (k as StoredKey).key === 'string' && typeof (k as StoredKey).id === 'string';

export class ProviderKeys {
  readonly pool: KeyPool;
  readonly path: string;
  /** Active keys of the file (at most `capacity`). */
  private stored: StoredKey[] = [];
  /** Keys of the file that are not active (kept). */
  private dormantStored: StoredKey[] = [];
  private envKeys: PoolKey[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly capacity: number;
  private readonly maxInFlight: number;

  constructor(dataDir: string, readonly provider: PoolProvider, options: { env?: NodeJS.ProcessEnv; maxInFlight?: number; waitTimeoutMs?: number; maxKeys?: number } = {}) {
    this.path = join(dataDir, 'providers', `keypool-${provider}.json`);
    this.maxInFlight = options.maxInFlight ?? 2;
    this.capacity = Math.max(1, Math.min(options.maxKeys ?? MAX_ACTIVE_KEYS[provider], MAX_POOL_KEYS));
    this.pool = new KeyPool({ maxInFlight: this.maxInFlight, ...(options.waitTimeoutMs ? { waitTimeoutMs: options.waitTimeoutMs } : {}) });
    const env = options.env ?? process.env;
    const seen = new Set<string>();
    this.envKeys = ENV_VARS[provider].flatMap(name => (env[name] ?? '').split(',')).map(s => s.trim()).filter(Boolean)
      .filter(key => !seen.has(key) && !!seen.add(key))
      .map((key, i) => ({ id: idOf(key, 'env'), label: `Env ${i + 1}`, key, source: 'env' as const, addedAtMs: 0 }));
  }

  /** How many simultaneous provider calls the active keys can carry (the dub queue is sized to this). */
  concurrencyLimit(): number { return this.maxInFlight * this.capacity; }

  /** Max active keys (1 for ElevenLabs). */
  maxKeys(): number { return this.capacity; }

  async load(): Promise<void> {
    let raw: Stored | undefined;
    try {
      raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
    } catch {
      raw = undefined; // unreadable file: start empty rather than crash the server
    }
    const keys = Array.isArray(raw?.keys) ? raw!.keys.filter(validStored) : [];
    const dormant = Array.isArray(raw?.dormant) ? raw!.dormant.filter(validStored) : [];
    this.stored = keys.slice(0, this.capacity);
    this.dormantStored = [...dormant, ...keys.slice(this.capacity)];
    // Old data with more keys than allowed: the overflow is moved aside once (kept on disk, no network involved).
    if (keys.length > this.capacity) await this.persist().catch(() => undefined);
    if (this.envKeys.length > this.capacity) console.warn(`[${this.provider}] ${this.warnings()[0]}`);
    this.sync();
  }

  private async persist(): Promise<void> {
    await writePrivateJsonFile(this.path, { keys: this.stored, ...(this.dormantStored.length ? { dormant: this.dormantStored } : {}) } satisfies Stored);
  }

  /** Keys in the pool: the environment first (it is the operator's decision), then the file's active keys. */
  private all(): PoolKey[] {
    return [...this.envKeys, ...this.stored.map(k => ({ id: k.id, label: k.label, key: k.key, source: 'store' as const, addedAtMs: k.addedAtMs }))].slice(0, this.capacity);
  }

  private everyKey(): string[] { return [...this.envKeys.map(k => k.key), ...this.stored.map(k => k.key), ...this.dormantStored.map(k => k.key)]; }

  private sync(): void { this.pool.setKeys(this.all()); }

  /** The secret of one ACTIVE key, for server-side calls only (never put in a response or a log). Dormant keys have none. */
  secretOf(id: string): string | undefined { return this.all().find(k => k.id === id)?.key; }

  /** Safe to send to the browser: the keys that are in use. */
  view(): KeyView[] { return this.pool.view(); }

  /** Keys that are kept but not used (old data, extra environment keys, stored keys shadowed by the environment). */
  dormantView(): DormantView[] {
    const active = new Set(this.all().map(k => k.id));
    const out: DormantView[] = [];
    for (const k of this.envKeys) if (!active.has(k.id)) out.push({ id: k.id, label: k.label, keyHint: hint(k.key), source: 'env', addedAtMs: 0, reason: 'env' });
    for (const k of this.stored) if (!active.has(k.id)) out.push({ id: k.id, label: k.label, keyHint: hint(k.key), source: 'store', addedAtMs: k.addedAtMs, reason: 'env' });
    for (const k of this.dormantStored) out.push({ id: k.id, label: k.label, keyHint: hint(k.key), source: 'store', addedAtMs: k.addedAtMs, reason: 'batas' });
    return out;
  }

  /** Plain-language notes for the UI (never contain a key). */
  warnings(): string[] {
    return this.envKeys.length > this.capacity
      ? [`Environment server berisi ${this.envKeys.length} kunci ${NAME[this.provider]}, tetapi hanya kunci pertama yang dipakai; sisanya tidak aktif.`]
      : [];
  }

  /** Whether `id` is a key of the server environment (read-only from the app). */
  isEnv(id: string): boolean { return this.envKeys.some(k => k.id === id); }

  /** The active key(s) come from the server environment: they can only be changed there. */
  managedByEnv(): boolean { return this.envKeys.length >= this.capacity; }

  /** Whether one more key can be added right now (false for a one-key provider that already has its key). */
  hasRoom(): boolean { return this.all().length < this.capacity; }

  private checkKey(input: { key: string; label?: string }): { key: string; label: string } {
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key.length < 16 || key.length > 300 || /\s/.test(key)) throw new ProviderInputError(`API key ${NAME[this.provider]} tidak valid`);
    const label = (input.label ?? '').trim();
    if (label.length > 40) throw new ProviderInputError('Label maksimal 40 karakter');
    return { key, label };
  }

  private full(): never {
    if (this.capacity === 1) throw new SingleKeyError();
    throw new ProviderInputError(`Pool ${NAME[this.provider]} maksimal ${this.capacity} key`);
  }

  async add(input: { key: string; label?: string }): Promise<KeyView> {
    const run = this.queue.then(async () => {
      const { key, label } = this.checkKey(input);
      if (this.everyKey().includes(key)) throw new ProviderInputError('API key ini sudah ada di pool');
      if (!this.hasRoom()) this.full();
      const entry: StoredKey = { id: idOf(key, 'k'), label: label || `Key ${this.all().length + 1}`, key, addedAtMs: Date.now() };
      const next = [...this.stored, entry];
      await writePrivateJsonFile(this.path, { keys: next, ...(this.dormantStored.length ? { dormant: this.dormantStored } : {}) } satisfies Stored);
      this.stored = next;
      this.sync();
      return this.view().find(v => v.id === entry.id)!;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * "Ganti kunci": the new key becomes the active one and the key it replaces is removed (the caller has already proved
   * the new key). The file is written before anything in memory changes: a failure leaves the old key untouched.
   */
  async replaceActive(input: { key: string; label?: string }): Promise<KeyView> {
    const run = this.queue.then(async () => {
      const { key, label } = this.checkKey(input);
      if (this.envKeys.length >= this.capacity) throw new ManagedByEnvError();
      const old = this.stored[0];
      if (this.everyKey().filter(k => k !== old?.key).includes(key)) throw new ProviderInputError('API key ini sudah ada di pool');
      const entry: StoredKey = { id: idOf(key, 'k'), label: label || old?.label || 'Key 1', key, addedAtMs: Date.now() };
      const next = [entry, ...this.stored.slice(1)];
      await writePrivateJsonFile(this.path, { keys: next, ...(this.dormantStored.length ? { dormant: this.dormantStored } : {}) } satisfies Stored);
      this.stored = next;
      this.sync();
      return this.view().find(v => v.id === entry.id)!;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Swaps a dormant (stored) key in; the key it replaces becomes dormant. `false` when there is no such dormant key. */
  async activate(id: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      const entry = this.dormantStored.find(k => k.id === id);
      if (!entry) return false;
      if (this.envKeys.length >= this.capacity) throw new ManagedByEnvError();
      const rest = this.dormantStored.filter(k => k.id !== id);
      const demoted = this.stored.length >= this.capacity ? this.stored.slice(this.capacity - 1) : [];
      const nextStored = [...this.stored.slice(0, this.capacity - 1), entry];
      const nextDormant = [...rest, ...demoted];
      await writePrivateJsonFile(this.path, { keys: nextStored, ...(nextDormant.length ? { dormant: nextDormant } : {}) } satisfies Stored);
      this.stored = nextStored;
      this.dormantStored = nextDormant;
      this.sync();
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** `false` when there is no such key or it comes from the environment. Removing the active key promotes nothing. */
  async remove(id: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      const inActive = this.stored.some(k => k.id === id);
      const inDormant = this.dormantStored.some(k => k.id === id);
      if (!inActive && !inDormant) return false;
      const nextStored = this.stored.filter(k => k.id !== id);
      const nextDormant = this.dormantStored.filter(k => k.id !== id);
      await writePrivateJsonFile(this.path, { keys: nextStored, ...(nextDormant.length ? { dormant: nextDormant } : {}) } satisfies Stored);
      this.stored = nextStored;
      this.dormantStored = nextDormant;
      this.sync();
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

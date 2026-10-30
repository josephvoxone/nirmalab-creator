/**
 * The API keys of one provider (ElevenLabs, Gemini): stored in `<dataDir>/providers/keypool-<provider>.json`
 * (0600), merged with keys from the server environment (`ELEVENLABS_API_KEYS=a,b`), at most 10 in total,
 * and loaded into a `KeyPool`. A key is never returned (only `keyHint`, the last 4 characters) and never logged.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from './private-json-file.js';
import { KeyPool, type KeyView, type PoolKey } from './key-pool.js';
import { ProviderInputError } from '../providers/config.js';

export const MAX_POOL_KEYS = 10;
export type PoolProvider = 'elevenlabs' | 'gemini';
const ENV_VAR: Record<PoolProvider, string> = { elevenlabs: 'ELEVENLABS_API_KEYS', gemini: 'GEMINI_API_KEYS' };
const NAME: Record<PoolProvider, string> = { elevenlabs: 'ElevenLabs', gemini: 'Gemini' };

type StoredKey = { id: string; label: string; key: string; addedAtMs: number };
type Stored = { keys: StoredKey[] };

const idOf = (key: string, prefix: string) => `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;

export class ProviderKeys {
  readonly pool: KeyPool;
  readonly path: string;
  private stored: StoredKey[] = [];
  private envKeys: PoolKey[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, readonly provider: PoolProvider, options: { env?: NodeJS.ProcessEnv; maxInFlight?: number; waitTimeoutMs?: number } = {}) {
    this.path = join(dataDir, 'providers', `keypool-${provider}.json`);
    this.pool = new KeyPool({ ...(options.maxInFlight ? { maxInFlight: options.maxInFlight } : {}), ...(options.waitTimeoutMs ? { waitTimeoutMs: options.waitTimeoutMs } : {}) });
    const raw = (options.env ?? process.env)[ENV_VAR[provider]] ?? '';
    this.envKeys = raw.split(',').map(s => s.trim()).filter(Boolean)
      .map((key, i) => ({ id: idOf(key, 'env'), label: `Env ${i + 1}`, key, source: 'env' as const, addedAtMs: 0 }));
  }

  async load(): Promise<void> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
      this.stored = Array.isArray(raw?.keys) ? raw!.keys.filter(k => k && typeof k.key === 'string' && typeof k.id === 'string') : [];
    } catch {
      this.stored = []; // unreadable file: start empty rather than crash the server
    }
    this.sync();
  }

  private all(): PoolKey[] {
    return [...this.envKeys, ...this.stored.map(k => ({ id: k.id, label: k.label, key: k.key, source: 'store' as const, addedAtMs: k.addedAtMs }))];
  }

  private sync(): void { this.pool.setKeys(this.all()); }

  /** The secret of one key, for server-side calls only (never put in a response or a log). */
  secretOf(id: string): string | undefined { return this.all().find(k => k.id === id)?.key; }

  /** Safe to send to the browser. */
  view(): KeyView[] { return this.pool.view(); }

  async add(input: { key: string; label?: string }): Promise<KeyView> {
    const run = this.queue.then(async () => {
      const key = typeof input.key === 'string' ? input.key.trim() : '';
      if (key.length < 16 || key.length > 300 || /\s/.test(key)) throw new ProviderInputError(`API key ${NAME[this.provider]} tidak valid`);
      const label = (input.label ?? '').trim();
      if (label.length > 40) throw new ProviderInputError('Label maksimal 40 karakter');
      const all = this.all();
      if (all.some(k => k.key === key)) throw new ProviderInputError('API key ini sudah ada di pool');
      if (all.length >= MAX_POOL_KEYS) throw new ProviderInputError(`Pool ${NAME[this.provider]} maksimal ${MAX_POOL_KEYS} key`);
      const entry: StoredKey = { id: idOf(key, 'k'), label: label || `Key ${all.length + 1}`, key, addedAtMs: Date.now() };
      await writePrivateJsonFile(this.path, { keys: [...this.stored, entry] } satisfies Stored);
      this.stored = [...this.stored, entry];
      this.sync();
      return this.view().find(v => v.id === entry.id)!;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** `false` when there is no such key or it comes from the environment. */
  async remove(id: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (!this.stored.some(k => k.id === id)) return false;
      const next = this.stored.filter(k => k.id !== id);
      await writePrivateJsonFile(this.path, { keys: next } satisfies Stored);
      this.stored = next;
      this.sync();
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

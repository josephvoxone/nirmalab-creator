/**
 * Personal access tokens for the remote MCP server (spec 6.5).
 * - Plaintext = `nc_` + 32 base62 chars from `crypto.randomBytes`; shown once at creation, never
 *   stored or logged. The file keeps only its sha256 hex.
 * - `<data>/mcp/tokens.json` (0600, via writePrivateJsonFile) = `{ version: 1, tokens: [{id, userId,
 *   name, sha256, createdAt, lastUsedAt}] }`. Revoking deletes the entry.
 * - `verify` accepts a token only while its owner still exists and is still an admin (read from
 *   the auth store on every call, so a demotion or removal takes effect at once).
 * - `lastUsedAt` is written at most once per minute per token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { AuthUser, UserAuthStore } from '../auth/store.js';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';

export const TOKEN_PATTERN = /^nc_[A-Za-z0-9]{32}$/;
export const MAX_TOKENS_PER_USER = 10;
export const MAX_TOKEN_NAME = 40;
const TOUCH_MS = 60_000;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export type McpTokenRecord = { id: string; userId: string; name: string; sha256: string; createdAt: string; lastUsedAt: string | null };
export type PublicMcpToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type VerifiedToken = { token: PublicMcpToken & { userId: string }; user: AuthUser };

export type McpTokenErrorCode = 'INVALID' | 'LIMIT';
export class McpTokenError extends Error {
  constructor(readonly code: McpTokenErrorCode, message: string) {
    super(message);
    this.name = 'McpTokenError';
  }
}

type TokenFile = { version: 1; tokens: McpTokenRecord[] };

/** 32 unbiased base62 chars (bytes ≥ 248 are dropped so every char is equally likely). */
export function newPlainToken(): string {
  let out = '';
  while (out.length < 32) {
    for (const byte of randomBytes(48)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === 32) break;
    }
  }
  return `nc_${out}`;
}

const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const toPublic = (r: McpTokenRecord): PublicMcpToken => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt ?? null });

export class McpTokenStore {
  readonly file: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, private readonly users: UserAuthStore, opts: { now?: () => number } = {}) {
    this.file = join(dataDir, 'mcp', 'tokens.json');
    this.now = opts.now ?? Date.now;
  }

  private async read(): Promise<McpTokenRecord[]> {
    const raw = (await readPrivateJsonFile(this.file)) as Partial<TokenFile> | undefined;
    return Array.isArray(raw?.tokens) ? raw.tokens.filter(t => t && typeof t.sha256 === 'string' && typeof t.id === 'string') : [];
  }

  /** Read-modify-write under one queue (one store instance per process). `fn` throwing writes nothing. */
  private update<T>(fn: (tokens: McpTokenRecord[]) => T): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const tokens = await this.read();
      const result = fn(tokens);
      await writePrivateJsonFile(this.file, { version: 1, tokens } satisfies TokenFile);
      return result;
    });
    this.queue = run;
    return run;
  }

  async list(userId: string): Promise<PublicMcpToken[]> {
    return (await this.read()).filter(t => t.userId === userId).map(toPublic);
  }

  /** A new token for `userId`; the plaintext is in the result only. */
  async create(userId: string, rawName: unknown): Promise<{ id: string; name: string; token: string }> {
    const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new McpTokenError('INVALID', 'Nama token wajib diisi');
    if (name.length > MAX_TOKEN_NAME) throw new McpTokenError('INVALID', `Nama token maksimal ${MAX_TOKEN_NAME} karakter`);
    const token = newPlainToken();
    const record: McpTokenRecord = {
      id: `tok_${randomBytes(8).toString('hex')}`, userId, name, sha256: sha256(token),
      createdAt: new Date(this.now()).toISOString(), lastUsedAt: null
    };
    await this.update(tokens => {
      if (tokens.filter(t => t.userId === userId).length >= MAX_TOKENS_PER_USER) {
        throw new McpTokenError('LIMIT', `Maksimal ${MAX_TOKENS_PER_USER} token per akun — cabut yang lama dulu`);
      }
      tokens.push(record);
    });
    return { id: record.id, name, token };
  }

  /** Revoke one of `userId`'s own tokens; false when it is not theirs or does not exist. */
  async revoke(userId: string, id: string): Promise<boolean> {
    return this.update(tokens => {
      const index = tokens.findIndex(t => t.id === id && t.userId === userId);
      if (index < 0) return false;
      tokens.splice(index, 1);
      return true;
    });
  }

  /**
   * The token's record and owner, or undefined for: a malformed or unknown token, a revoked one,
   * an owner that was removed or is no longer an admin.
   */
  async verify(plain: unknown): Promise<VerifiedToken | undefined> {
    if (typeof plain !== 'string' || !TOKEN_PATTERN.test(plain)) return undefined;
    const wanted = Buffer.from(sha256(plain), 'hex');
    let match: McpTokenRecord | undefined;
    for (const record of await this.read()) {
      const stored = Buffer.from(record.sha256, 'hex');
      // Constant-time on the digests; the loop always runs to the end.
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) match = record;
    }
    if (!match) return undefined;
    const user = this.users.findUserById(match.userId);
    if (!user || !user.isAdmin) return undefined;
    let lastUsedAt = match.lastUsedAt ?? null;
    const now = this.now();
    if (!lastUsedAt || now - Date.parse(lastUsedAt) >= TOUCH_MS) {
      const stamp = new Date(now).toISOString();
      lastUsedAt = stamp;
      const id = match.id;
      // A failed stamp never blocks the call.
      await this.update(tokens => { const t = tokens.find(x => x.id === id); if (t) t.lastUsedAt = stamp; }).catch(() => undefined);
    }
    return { token: { ...toPublic({ ...match, lastUsedAt }), userId: match.userId }, user };
  }
}

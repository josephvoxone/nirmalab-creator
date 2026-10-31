import { createHash, randomBytes } from 'node:crypto';

export type OAuthStateRecord = {
  state: string;
  platform: string;
  /** The user who started the connection: the callback saves the token for this user and nobody else. */
  userId: string;
  codeVerifier?: string;
  createdAtMs: number;
};

export type OAuthStateConsumed =
  | { ok: true; record: OAuthStateRecord }
  | { ok: false; reason: 'unknown' | 'anonymous' | 'wrong-user' };

const TTL_MS = 10 * 60 * 1000;

/** In-memory OAuth state (CSRF + PKCE). Pending flows complete in minutes. */
export class OAuthStateStore {
  private readonly states = new Map<string, OAuthStateRecord>();

  create(platform: string, userId: string, codeVerifier?: string): string {
    this.prune();
    const state = randomBytes(24).toString('hex');
    this.states.set(state, { state, platform, userId, codeVerifier, createdAtMs: Date.now() });
    return state;
  }

  /**
   * Redeems a state for the browser that comes back. The callback is a PUBLIC route (the provider redirects the
   * browser; no Authorization header), so the only proof of who is finishing the flow is the session cookie:
   * `sessionUserId` must be the user who started it. A refused attempt does NOT use the state up — the rightful
   * user can still finish — and a successful one removes it (single use).
   */
  consume(state: string, platform: string, sessionUserId: string | undefined): OAuthStateConsumed {
    this.prune();
    const record = this.states.get(state);
    if (!record || record.platform !== platform) return { ok: false, reason: 'unknown' };
    if (!sessionUserId) return { ok: false, reason: 'anonymous' };
    if (record.userId !== sessionUserId) return { ok: false, reason: 'wrong-user' };
    this.states.delete(state);
    return { ok: true, record };
  }

  /** Forgets every pending flow of this user (account removal). Returns how many there were. */
  revokeAllFor(userId: string): number {
    let removed = 0;
    for (const [key, record] of this.states) {
      if (record.userId === userId) { this.states.delete(key); removed += 1; }
    }
    return removed;
  }

  stateHash(state: string): string {
    return createHash('sha256').update(state).digest('hex');
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, record] of this.states) {
      if (record.createdAtMs < cutoff) this.states.delete(key);
    }
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

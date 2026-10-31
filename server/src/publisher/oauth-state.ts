import { createHash, randomBytes } from 'node:crypto';

export type OAuthStateRecord = {
  state: string;
  platform: string;
  /** The user who started the connection: the callback saves the token for this user and nobody else. */
  userId: string;
  codeVerifier?: string;
  createdAtMs: number;
};

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

  consume(state: string, platform: string): OAuthStateRecord | undefined {
    this.prune();
    const record = this.states.get(state);
    if (!record || record.platform !== platform) return undefined;
    this.states.delete(state);
    return record;
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

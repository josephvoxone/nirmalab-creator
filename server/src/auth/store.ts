import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashPassword, newAuthToken, normalizeEmail, verifyPassword } from './password.js';

export type AuthUser = {
  id: string;
  email: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
  invitedBy?: string;
};

export type AuthInvite = {
  tokenHash: string;
  email?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  usedBy?: string;
  createdBy: string;
};

export type AuthSession = {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

type AuthDocument = {
  version: 1;
  users: AuthUser[];
  invites: AuthInvite[];
  sessions: AuthSession[];
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyDocument(): AuthDocument {
  return { version: 1, users: [], invites: [], sessions: [] };
}

export class UserAuthStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'auth.json');
  }

  hasUsers(): boolean {
    return this.read().users.length > 0;
  }

  findUserByEmail(email: string): AuthUser | undefined {
    const normalized = normalizeEmail(email);
    return this.read().users.find(user => user.email === normalized);
  }

  findUserById(id: string): AuthUser | undefined {
    return this.read().users.find(user => user.id === id);
  }

  async createUser(input: {
    email: string;
    password: string;
    isAdmin: boolean;
    invitedBy?: string;
  }): Promise<AuthUser> {
    const doc = this.read();
    const email = normalizeEmail(input.email);
    if (doc.users.some(user => user.email === email)) {
      throw new Error('Email already registered');
    }
    const user: AuthUser = {
      id: `u_${newAuthToken(12)}`,
      email,
      passwordHash: await hashPassword(input.password),
      isAdmin: input.isAdmin,
      createdAt: nowIso(),
      ...(input.invitedBy === undefined ? {} : { invitedBy: input.invitedBy })
    };
    doc.users.push(user);
    this.write(doc);
    return user;
  }

  async verifyCredentials(email: string, password: string): Promise<AuthUser | undefined> {
    const user = this.findUserByEmail(email);
    if (!user) return undefined;
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user : undefined;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<AuthUser> {
    const doc = this.read();
    const user = doc.users.find(entry => entry.id === userId);
    if (!user) throw new Error('User not found');
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw new Error('Current password is wrong');
    user.passwordHash = await hashPassword(newPassword);
    this.write(doc);
    return user;
  }

  createInvite(input: { email?: string; createdBy: string }): { token: string; invite: AuthInvite } {
    const doc = this.read();
    const token = newAuthToken(24);
    const createdAt = Date.now();
    const invite: AuthInvite = {
      tokenHash: hashToken(token),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + INVITE_TTL_MS).toISOString(),
      createdBy: input.createdBy,
      ...(input.email === undefined || input.email.trim().length === 0
        ? {}
        : { email: normalizeEmail(input.email) })
    };
    doc.invites.push(invite);
    this.write(doc);
    return { token, invite };
  }

  peekInvite(token: string): AuthInvite | undefined {
    const wanted = hashToken(token);
    const invite = this.read().invites.find(entry => entry.tokenHash === wanted);
    if (!invite || invite.usedAt || Date.parse(invite.expiresAt) < Date.now()) return undefined;
    return invite;
  }

  async acceptInvite(input: { token: string; email: string; password: string }): Promise<AuthUser> {
    const doc = this.read();
    const wanted = hashToken(input.token);
    const invite = doc.invites.find(entry => entry.tokenHash === wanted);
    if (!invite || invite.usedAt || Date.parse(invite.expiresAt) < Date.now()) {
      throw new Error('Invite invalid or expired');
    }
    const email = normalizeEmail(input.email);
    if (invite.email && invite.email !== email) {
      throw new Error('Invite was issued for a different email');
    }
    if (doc.users.some(user => user.email === email)) {
      throw new Error('Email already registered');
    }
    const user: AuthUser = {
      id: `u_${newAuthToken(12)}`,
      email,
      passwordHash: await hashPassword(input.password),
      isAdmin: false,
      createdAt: nowIso(),
      invitedBy: invite.createdBy
    };
    doc.users.push(user);
    invite.usedAt = nowIso();
    invite.usedBy = user.id;
    this.write(doc);
    return user;
  }

  revokeInvite(tokenHash: string, byUserId: string): boolean {
    const doc = this.read();
    const invite = doc.invites.find(entry => entry.tokenHash === tokenHash);
    if (!invite || invite.usedAt) return false;
    const requester = doc.users.find(user => user.id === byUserId);
    if (!requester?.isAdmin && invite.createdBy !== byUserId) return false;
    invite.usedAt = nowIso();
    invite.usedBy = byUserId;
    this.write(doc);
    return true;
  }

  listInvites(): AuthInvite[] {
    return this.read().invites;
  }

  createSession(userId: string): { token: string; session: AuthSession } {
    const doc = this.read();
    const token = newAuthToken(32);
    const createdAt = Date.now();
    const session: AuthSession = {
      tokenHash: hashToken(token),
      userId,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + SESSION_TTL_MS).toISOString()
    };
    doc.sessions = doc.sessions.filter(entry => Date.parse(entry.expiresAt) >= createdAt);
    doc.sessions.push(session);
    this.write(doc);
    return { token, session };
  }

  resolveSession(token: string): AuthUser | undefined {
    const doc = this.read();
    const wanted = hashToken(token);
    const session = doc.sessions.find(entry => entry.tokenHash === wanted);
    if (!session || Date.parse(session.expiresAt) < Date.now()) return undefined;
    return doc.users.find(user => user.id === session.userId);
  }

  destroySession(token: string): void {
    const doc = this.read();
    const wanted = hashToken(token);
    const kept = doc.sessions.filter(entry => entry.tokenHash !== wanted);
    if (kept.length === doc.sessions.length) return;
    doc.sessions = kept;
    this.write(doc);
  }

  publicUser(user: AuthUser): { id: string; email: string; isAdmin: boolean; createdAt: string } {
    return { id: user.id, email: user.email, isAdmin: user.isAdmin, createdAt: user.createdAt };
  }

  private read(): AuthDocument {
    try {
      if (!existsSync(this.file)) return emptyDocument();
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return emptyDocument();
      const doc = parsed as Partial<AuthDocument>;
      return {
        version: 1,
        users: Array.isArray(doc.users) ? doc.users : [],
        invites: Array.isArray(doc.invites) ? doc.invites : [],
        sessions: Array.isArray(doc.sessions) ? doc.sessions : []
      };
    } catch {
      return emptyDocument();
    }
  }

  private write(doc: AuthDocument): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }
}

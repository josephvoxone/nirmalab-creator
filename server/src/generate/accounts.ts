import { join } from 'node:path';
import {
  deletePrivateJsonFile,
  readPrivateJsonFile,
  writePrivateJsonFile
} from '../lib/private-json-file.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export type PoolAccount = {
  id: string;
  label: string;
  /** absolute path to a cookie jar / profile dir on the server (0600) */
  secretRef?: string;
  cooldownUntilMs?: number;
  usedToday?: number;
  dayStamp?: string;
};

export type PoolState = {
  version: 1;
  accounts: PoolAccount[];
};

/** Server-side account pool: rotation + cooldown + daily counters. Secrets live in referenced files, never here. */
export class AccountPoolStore {
  constructor(private readonly root: string) {}

  private path(provider: string): string {
    return join(this.root, `${provider}.pool.json`);
  }

  async list(provider: string): Promise<PoolAccount[]> {
    const raw = await readPrivateJsonFile(this.path(provider));
    if (!raw || typeof raw !== 'object') return [];
    const state = raw as Partial<PoolState>;
    return Array.isArray(state.accounts) ? state.accounts : [];
  }

  async upsert(provider: string, account: PoolAccount): Promise<void> {
    const accounts = await this.list(provider);
    const index = accounts.findIndex(a => a.id === account.id);
    if (index >= 0) accounts[index] = { ...accounts[index], ...account };
    else accounts.push(account);
    await writePrivateJsonFile(this.path(provider), { version: 1, accounts } satisfies PoolState);
  }

  async remove(provider: string, id: string): Promise<void> {
    const accounts = (await this.list(provider)).filter(a => a.id !== id);
    await writePrivateJsonFile(this.path(provider), { version: 1, accounts } satisfies PoolState);
  }

  async clear(provider: string): Promise<void> {
    await deletePrivateJsonFile(this.path(provider));
  }

  private secretPath(provider: string, id: string): string {
    return join(this.root, 'secrets', provider, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
  }

  /** Cookie/token vault (0600 files, never returned by list/status). */
  async saveSecret(provider: string, id: string, value: string): Promise<void> {
    if (!value) throw new Error('Empty secret');
    const path = this.secretPath(provider, id);
    await mkdir(join(this.root, 'secrets', provider), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  }

  async readSecret(provider: string, id: string): Promise<string | undefined> {
    try {
      const value = await readFile(this.secretPath(provider, id), 'utf8');
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async deleteSecret(provider: string, id: string): Promise<void> {
    await deletePrivateJsonFile(this.secretPath(provider, id));
  }

  /** Pick the oldest-rested, non-cooled account; resets daily counters automatically. */
  async pick(provider: string, dailyCap?: number): Promise<PoolAccount | undefined> {
    const today = new Date().toISOString().slice(0, 10);
    const accounts = await this.list(provider);
    const now = Date.now();
    const eligible = accounts.filter(a => {
      const used = a.dayStamp === today ? (a.usedToday ?? 0) : 0;
      if (dailyCap !== undefined && used >= dailyCap) return false;
      return !(a.cooldownUntilMs !== undefined && a.cooldownUntilMs > now);
    });
    eligible.sort((a, b) => (a.cooldownUntilMs ?? 0) - (b.cooldownUntilMs ?? 0));
    return eligible[0];
  }

  async markUsed(provider: string, id: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const accounts = await this.list(provider);
    const account = accounts.find(a => a.id === id);
    if (!account) return;
    account.usedToday = (account.dayStamp === today ? (account.usedToday ?? 0) : 0) + 1;
    account.dayStamp = today;
    await writePrivateJsonFile(this.path(provider), { version: 1, accounts } satisfies PoolState);
  }

  async markCooldown(provider: string, id: string, ms: number): Promise<void> {
    const accounts = await this.list(provider);
    const account = accounts.find(a => a.id === id);
    if (!account) return;
    account.cooldownUntilMs = Date.now() + ms;
    await writePrivateJsonFile(this.path(provider), { version: 1, accounts } satisfies PoolState);
  }
}

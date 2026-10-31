import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateGenerateFiles, rollbackGenerateMigration } from '../src/generate/migrate.js';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function legacyDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gen-mig-'));
  const fg = join(dir, 'free-generate');
  for (const [kind, name, byte] of [['tts', 'tts-1-1.mp3', 1], ['tts', 'tts-2-2.mp3', 2], ['images', 'pollinations-3-3.jpg', 3]] as const) {
    mkdirSync(join(fg, kind), { recursive: true });
    writeFileSync(join(fg, kind, name), Buffer.alloc(3000, byte));
  }
  mkdirSync(join(fg, 'clips', 'pollinations'), { recursive: true });
  writeFileSync(join(fg, 'clips', 'pollinations', 'pollinations-4-4.mp4'), Buffer.alloc(5000, 4));
  mkdirSync(join(fg, 'pools'), { recursive: true });
  writeFileSync(join(fg, 'pools', 'bing.json'), '{"accounts":[]}');
  return dir;
}
const tree = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p.slice(root.length)); } };
  walk(root);
  return out.sort();
};

describe('T4-3: legacy free-generate files move to the main owner (backup + manifest + rollback)', () => {
  it('moves every legacy file under users/<owner>/<kind>, keeps pools, writes a manifest and a backup', async () => {
    const dir = legacyDataDir();
    const before = new Map(tree(join(dir, 'free-generate')).filter(p => !p.startsWith('/pools')).map(p => [p.split('/').pop()!, sha(join(dir, 'free-generate', p))]));
    const report = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    expect(report.moved).toHaveLength(4);
    const dest = join(dir, 'free-generate', 'users', 'u_main');
    expect(tree(dest)).toEqual(['/clips/pollinations/pollinations-4-4.mp4', '/images/pollinations-3-3.jpg', '/tts/tts-1-1.mp3', '/tts/tts-2-2.mp3']);
    for (const [name, hash] of before) {
      const found = tree(dest).find(p => p.endsWith(name))!;
      expect(sha(join(dest, found)), name).toBe(hash);
    }
    // the old folders hold no files any more; pools untouched
    expect(tree(join(dir, 'free-generate', 'tts'))).toEqual([]);
    expect(tree(join(dir, 'free-generate', 'pools'))).toEqual(['/bing.json']);
    // backup: every moved file is still reachable under tenancy/backup-*
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest.status).toBe('applied');
    expect(manifest.entries).toHaveLength(4);
    for (const entry of manifest.entries) expect(existsSync(join(dir, 'tenancy', entry.backup)), entry.backup).toBe(true);
  });

  it('is idempotent: a second run moves nothing and writes no second manifest', async () => {
    const dir = legacyDataDir();
    await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    const manifests = readdirSync(join(dir, 'tenancy', 'migrations'));
    const again = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    expect(again.moved).toEqual([]);
    expect(again.manifest).toBeUndefined();
    expect(readdirSync(join(dir, 'tenancy', 'migrations'))).toEqual(manifests);
  });

  it('dry run writes nothing; no owner means nothing moves', async () => {
    const dir = legacyDataDir();
    const snapshot = tree(dir);
    const dry = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main', dryRun: true });
    expect(dry.moved).toHaveLength(4);
    expect(tree(dir)).toEqual(snapshot);
    const none = await migrateGenerateFiles({ dataDir: dir, ownerId: undefined });
    expect(none.moved).toEqual([]);
    expect(tree(dir)).toEqual(snapshot);
  });

  it('does not overwrite a file that already exists in the owner folder (the legacy one stays put)', async () => {
    const dir = legacyDataDir();
    mkdirSync(join(dir, 'free-generate', 'users', 'u_main', 'tts'), { recursive: true });
    writeFileSync(join(dir, 'free-generate', 'users', 'u_main', 'tts', 'tts-1-1.mp3'), 'NEW');
    const report = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    expect(report.conflicts).toEqual(['tts/tts-1-1.mp3']);
    expect(readFileSync(join(dir, 'free-generate', 'users', 'u_main', 'tts', 'tts-1-1.mp3'), 'utf8')).toBe('NEW');
    expect(existsSync(join(dir, 'free-generate', 'tts', 'tts-1-1.mp3'))).toBe(true);
  });

  it('refuses an owner id that could escape the folder', async () => {
    const dir = legacyDataDir();
    await expect(migrateGenerateFiles({ dataDir: dir, ownerId: '../x' })).rejects.toThrow();
  });

  it('rollback puts every file back byte-identical and keeps the backup', async () => {
    const dir = legacyDataDir();
    const before = tree(join(dir, 'free-generate'));
    const hashes = before.map(p => sha(join(dir, 'free-generate', p)));
    const report = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    const undone = await rollbackGenerateMigration(report.manifest!);
    expect(undone.restored).toHaveLength(4);
    expect(tree(join(dir, 'free-generate')).filter(p => !p.startsWith('/users'))).toEqual(before);
    expect(before.map(p => sha(join(dir, 'free-generate', p)))).toEqual(hashes);
    expect(tree(join(dir, 'free-generate', 'users'))).toEqual([]);
    // a second rollback is a no-op, and the migration can run again
    expect((await rollbackGenerateMigration(report.manifest!)).restored).toEqual([]);
    expect((await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' })).moved).toHaveLength(4);
  });

  it('rollback restores from the backup when the moved file has been lost', async () => {
    const dir = legacyDataDir();
    const report = await migrateGenerateFiles({ dataDir: dir, ownerId: 'u_main' });
    const moved = join(dir, 'free-generate', 'users', 'u_main', 'tts', 'tts-1-1.mp3');
    const { rmSync } = await import('node:fs');
    rmSync(moved);
    const undone = await rollbackGenerateMigration(report.manifest!);
    expect(undone.restored).toContain('tts/tts-1-1.mp3');
    expect(readFileSync(join(dir, 'free-generate', 'tts', 'tts-1-1.mp3')).length).toBe(3000);
    void linkSync; void lstatSync;
  });
});

describe('T4-3: the migration runs at boot (buildApp)', () => {
  const ENV = { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' };
  const boot = async (extraEnv: Record<string, string> = {}, dir = legacyDataDir()) => {
    const { buildApp } = await import('../src/app.js');
    const server = await buildApp({ dataDir: dir, env: { ...ENV, ...extraEnv }, logger: false, stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 } });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const me = (await server.inject({ url: '/api/auth/me', headers: { cookie } })).json() as { user: { id: string } };
    return { server, dir, cookie, adminId: me.user.id };
  };

  it('legacy files land in the admin\'s folder and the old URL still opens them for the admin', async () => {
    const t = await boot();
    expect(tree(join(t.dir, 'free-generate', 'users', t.adminId)).filter(p => p.startsWith('/tts'))).toEqual(['/tts/tts-1-1.mp3', '/tts/tts-2-2.mp3']);
    const res = await t.server.inject({ url: '/api/generate/files/tts/tts-1-1.mp3', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(3000);
    await t.server.close();
  });

  it('TENANCY_MIGRATE=0 and TENANCY_DRY_RUN=1 leave the folders alone', async () => {
    for (const env of [{ TENANCY_MIGRATE: '0' }, { TENANCY_DRY_RUN: '1' }]) {
      const dir = legacyDataDir();
      const before = tree(join(dir, 'free-generate'));
      const t = await boot(env, dir);
      expect(tree(join(dir, 'free-generate'))).toEqual(before);
      await t.server.close();
    }
  });
});

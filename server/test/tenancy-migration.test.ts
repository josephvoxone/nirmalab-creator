import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';
import { ensureOwners, MIGRATION_ID, rollbackMigration } from '../src/tenancy/migrate.js';

const board = (title: string): Storyboard => ({
  title, characters: {}, audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' }]
});
const ROLLBACK = fileURLToPath(new URL('../../scripts/tenancy-rollback.mjs', import.meta.url));
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

type World = Awaited<ReturnType<typeof world>>;

/** QA admin (oldest), Joseph (admin), Bob (member), Siti (admin 2); projects: A Joseph's, B ownerless, C orphan, D QA's, E Bob's, + Lentera ownerless. */
async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-mig-'));
  const auth = new UserAuthStore(dataDir);
  const qa = await auth.createUser({ email: 'qa-admin@example.local', password: 'qa-pass-123', isAdmin: true });
  await new Promise(r => setTimeout(r, 4));
  const joseph = await auth.createUser({ email: 'joseph@x.io', password: 'joseph-pass-1', isAdmin: true });
  await new Promise(r => setTimeout(r, 4));
  const bob = await auth.createUser({ email: 'bob@x.io', password: 'bob-pass-123', isAdmin: false });
  await new Promise(r => setTimeout(r, 4));
  const siti = await auth.createUser({ email: 'siti@x.io', password: 'siti-pass-123', isAdmin: true });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
  const A = await service.create(board('Proyek A'), { createdBy: joseph.id });
  const B = await service.create(board('Proyek B tanpa pemilik'));
  const C = await service.create(board('Proyek C yatim'), { createdBy: 'u_sudah_dihapus' });
  const D = await service.create(board('Proyek D milik QA'), { createdBy: qa.id });
  const E = await service.create(board('Proyek E milik Bob'), { createdBy: bob.id });
  // Lentera: a real production id, created before owners were recorded.
  const lentera = await service.create(board('Lentera'));
  const LENTERA = 'story_83dc8016d54e4974';
  const oldDir = service.storyDir(lentera.id);
  const newDir = service.storyDir(LENTERA);
  (await import('node:fs')).renameSync(oldDir, newDir);
  const rec = JSON.parse(readFileSync(join(newDir, 'story.json'), 'utf8'));
  writeFileSync(join(newDir, 'story.json'), JSON.stringify({ ...rec, id: LENTERA }, null, 1));
  const users = auth.listUsers();
  return { dataDir, auth, service, users, joseph, bob, siti, qa, ids: { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id, LENTERA } };
}

const storyFile = (w: World, id: string) => join(w.dataDir, 'stories', id, 'story.json');
const bytesOf = (w: World) => Object.fromEntries(Object.values(w.ids).map(id => [id, readFileSync(storyFile(w, id))]));
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(join(dir, e.name)).map(f => `${e.name}/${f}`) : [e.name]).sort();

describe('T1 ensureOwners — invariants C.5', () => {
  it('C.5.1: ownerless projects go to the primary owner (oldest NON-QA admin); owned, orphaned and QA-owned projects are untouched; nothing disappears', async () => {
    const w = await world();
    const before = bytesOf(w);
    const stories = tree(join(w.dataDir, 'stories'));
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users, lock: w.service.lockStory.bind(w.service) });

    expect(report.primaryOwner).toMatchObject({ id: w.joseph.id, email: 'joseph@x.io', via: 'oldest-admin' });
    expect(report.assigned.map(a => a.id).sort()).toEqual([w.ids.B, w.ids.LENTERA].sort());
    expect(report.orphans.map(o => o.id)).toEqual([w.ids.C]);
    expect(report.orphans[0]).toMatchObject({ title: 'Proyek C yatim', ownerId: 'u_sudah_dihapus' });
    expect(report.qaOwned).toEqual([{ id: w.ids.D, ownerId: w.qa.id }]);
    expect(report.unassigned).toEqual([]);

    expect((await w.service.listFor(w.joseph.id)).map(r => r.id).sort()).toEqual([w.ids.A, w.ids.B, w.ids.LENTERA].sort());
    expect((await w.service.listFor(w.bob.id)).map(r => r.id)).toEqual([w.ids.E]);
    expect((await w.service.listFor(w.siti.id))).toEqual([]);
    expect((await w.service.listFor(w.qa.id)).map(r => r.id)).toEqual([w.ids.D]);
    // same directories before/after (the migration only adds tenancy/ beside them)
    expect(tree(join(w.dataDir, 'stories'))).toEqual(stories);
    // A, C, D, E: byte-identical
    for (const id of [w.ids.A, w.ids.C, w.ids.D, w.ids.E]) expect(readFileSync(storyFile(w, id)).equals(before[id]!), id).toBe(true);
    // B and Lentera: ONLY the three owner fields were added; revision and timestamps did not move
    for (const id of [w.ids.B, w.ids.LENTERA]) {
      const was = JSON.parse(before[id]!.toString());
      const now = JSON.parse(readFileSync(storyFile(w, id), 'utf8'));
      const { createdBy, ownerAssignedBy, ownerAssignedAt, ...rest } = now;
      expect(rest).toEqual(was);
      expect(createdBy).toBe(w.joseph.id);
      expect(ownerAssignedBy).toBe(MIGRATION_ID);
      expect(typeof ownerAssignedAt).toBe('string');
      expect(now.rev).toBe(was.rev);
      expect(now.updatedAtMs).toBe(was.updatedAtMs);
    }
    // the storyboards were never opened for writing
    expect(existsSync(join(w.dataDir, 'tenancy'))).toBe(true);
  });

  it('C.5.1b: TENANCY_DEFAULT_OWNER_EMAIL wins over the oldest admin; an email that matches no account is an error, never a silent fallback', async () => {
    const w = await world();
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users, defaultOwnerEmail: ' Siti@X.io ', dryRun: true });
    expect(report.primaryOwner).toMatchObject({ id: w.siti.id, via: 'env' });
    await expect(ensureOwners({ dataDir: w.dataDir, users: w.users, defaultOwnerEmail: 'salah@x.io' })).rejects.toThrow(/TENANCY_DEFAULT_OWNER_EMAIL/);
    expect((JSON.parse(readFileSync(storyFile(w, w.ids.B), 'utf8'))).createdBy).toBeUndefined();
  });

  it('C.5.2: running twice writes nothing the second time (no second manifest, files untouched)', async () => {
    const w = await world();
    await ensureOwners({ dataDir: w.dataDir, users: w.users });
    const afterFirst = bytesOf(w);
    const manifests = readdirSync(join(w.dataDir, 'tenancy', 'migrations'));
    expect(manifests).toHaveLength(1);
    const mtimes = Object.values(w.ids).map(id => statSync(storyFile(w, id)).mtimeMs);
    const again = await ensureOwners({ dataDir: w.dataDir, users: w.users });
    expect(again.assigned).toEqual([]);
    expect(again.manifest).toBeUndefined();
    expect(readdirSync(join(w.dataDir, 'tenancy', 'migrations'))).toEqual(manifests);
    expect(readdirSync(join(w.dataDir, 'tenancy')).filter(n => n.startsWith('backup-'))).toHaveLength(1);
    for (const [id, buf] of Object.entries(afterFirst)) expect(readFileSync(storyFile(w, id)).equals(buf)).toBe(true);
    expect(Object.values(w.ids).map(id => statSync(storyFile(w, id)).mtimeMs)).toEqual(mtimes);
  });

  it('two runs at the same time still assign each project exactly once (per-story lock + compare-and-set)', async () => {
    const w = await world();
    const lock = w.service.lockStory.bind(w.service);
    const [x, y] = await Promise.all([ensureOwners({ dataDir: w.dataDir, users: w.users, lock }), ensureOwners({ dataDir: w.dataDir, users: w.users, lock })]);
    expect(x.assigned.length + y.assigned.length).toBe(2);
    // the runs are serialised: the second one scans only after the first finished, so it finds nothing left to do
    expect([x.assigned.length, y.assigned.length, y.alreadyOwned]).toEqual([2, 0, 5]);
    const manifests = readdirSync(join(w.dataDir, 'tenancy', 'migrations'));
    expect(manifests).toHaveLength(1);
    const m = JSON.parse(readFileSync(join(w.dataDir, 'tenancy', 'migrations', manifests[0]!), 'utf8'));
    expect(m.entries).toHaveLength(2);
    expect(readdirSync(join(w.dataDir, 'stories', w.ids.B)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('compare-and-set: a project that gains an owner between the scan and the write keeps that owner (the migration never overwrites createdBy)', async () => {
    const w = await world();
    const lock = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (id === w.ids.B) {
        const rec = JSON.parse(readFileSync(storyFile(w, id), 'utf8'));
        writeFileSync(storyFile(w, id), JSON.stringify({ ...rec, createdBy: w.bob.id }, null, 1));
      }
      return w.service.lockStory(id, fn);
    };
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users, lock });
    expect(report.assigned.map(a => a.id)).toEqual([w.ids.LENTERA]);
    expect(await w.service.ownerOf(w.ids.B)).toBe(w.bob.id);
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest.entries.map((e: { id: string }) => e.id)).toEqual([w.ids.LENTERA]);
  });

  it('dry run: reports the plan and writes nothing at all (not even tenancy/)', async () => {
    const w = await world();
    const before = tree(w.dataDir);
    const bytes = bytesOf(w);
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.assigned.map(a => a.id).sort()).toEqual([w.ids.B, w.ids.LENTERA].sort());
    expect(tree(w.dataDir)).toEqual(before);
    for (const [id, buf] of Object.entries(bytes)) expect(readFileSync(storyFile(w, id)).equals(buf)).toBe(true);
  });

  it('C.5.3: rollback(manifest) gives back byte-identical story.json files, keeps backups, and is itself repeatable', async () => {
    const w = await world();
    const before = bytesOf(w);
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users });
    expect(report.manifest).toBeDefined();
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest.id).toBe(MIGRATION_ID);
    expect(manifest.entries[0]).toMatchObject({ field: 'createdBy', before: null });
    const result = await rollbackMigration(report.manifest!, { dataDir: w.dataDir });
    expect(result.restored.sort()).toEqual([w.ids.B, w.ids.LENTERA].sort());
    for (const [id, buf] of Object.entries(before)) expect(readFileSync(storyFile(w, id)).equals(buf), id).toBe(true);
    const second = await rollbackMigration(report.manifest!, { dataDir: w.dataDir });
    expect(second.restored).toEqual([]);
    // and the project is ownerless again, so the next boot assigns it again (idempotent system, reversible step)
    expect(await w.service.ownerOf(w.ids.B)).toBeUndefined();
  });

  it('rollback after the project moved on (status changed since) reverts ONLY the three owner fields, keeping the later work', async () => {
    const w = await world();
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users });
    const file = storyFile(w, w.ids.B);
    const moved = JSON.parse(readFileSync(file, 'utf8'));
    moved.status = 'review';
    moved.rev = 5;
    writeFileSync(file, JSON.stringify(moved, null, 1));
    const result = await rollbackMigration(report.manifest!, { dataDir: w.dataDir });
    expect(result.revertedFields).toContain(w.ids.B);
    const now = JSON.parse(readFileSync(file, 'utf8'));
    expect(now.status).toBe('review');
    expect(now.rev).toBe(5);
    expect(now.createdBy).toBeUndefined();
    expect(now.ownerAssignedBy).toBeUndefined();
  });

  it('scripts/tenancy-rollback.mjs does the same from the command line (dry-run first, then for real)', async () => {
    const w = await world();
    const before = bytesOf(w);
    const report = await ensureOwners({ dataDir: w.dataDir, users: w.users });
    const dry = execFileSync('node', [ROLLBACK, report.manifest!, '--dry-run'], { encoding: 'utf8' });
    expect(dry).toMatch(/dry-run/i);
    expect(JSON.parse(readFileSync(storyFile(w, w.ids.B), 'utf8')).createdBy).toBe(w.joseph.id);
    const out = execFileSync('node', [ROLLBACK, report.manifest!], { encoding: 'utf8' });
    expect(out).toContain(w.ids.B);
    for (const [id, buf] of Object.entries(before)) expect(readFileSync(storyFile(w, id)).equals(buf), id).toBe(true);
    expect(sha(out)).not.toContain('Proyek B');
  });

  it('C.5.4: with enforce, a project that cannot be given an owner stops the boot with a message — it is never silently hidden', async () => {
    const w = await world();
    await expect(ensureOwners({ dataDir: w.dataDir, users: [], enforce: true })).rejects.toThrow(/tanpa pemilik/);
    const soft = await ensureOwners({ dataDir: w.dataDir, users: [], enforce: false });
    expect(soft.primaryOwner).toBeUndefined();
    expect(soft.unassigned.sort()).toEqual([w.ids.B, w.ids.LENTERA].sort());
    expect(existsSync(join(w.dataDir, 'tenancy'))).toBe(false);
    // a corrupt story.json is reported, and under enforce it also stops the boot
    writeFileSync(storyFile(w, w.ids.E), '{ not json');
    const corrupt = await ensureOwners({ dataDir: w.dataDir, users: w.users, dryRun: true });
    expect(corrupt.unreadable).toEqual([w.ids.E]);
    await expect(ensureOwners({ dataDir: w.dataDir, users: w.users, enforce: true })).rejects.toThrow(/tidak terbaca/);
  });

  it('C.5.5: Lentera (ownerless fixture) is in the primary owner\'s list and in nobody else\'s', async () => {
    const w = await world();
    await ensureOwners({ dataDir: w.dataDir, users: w.users });
    expect((await w.service.listFor(w.joseph.id)).map(r => r.id)).toContain('story_83dc8016d54e4974');
    for (const other of [w.siti, w.bob, w.qa]) expect((await w.service.listFor(other.id)).map(r => r.id)).not.toContain('story_83dc8016d54e4974');
  });
});

describe('T1 boot wiring', () => {
  const env = { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' };
  const quiet = { stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 } } as const;

  it('buildApp assigns an ownerless project to the bootstrap admin at boot, once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-boot-'));
    const flow = new FlowStore(join(dataDir, 'flow'));
    const svc = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
    const loose = await svc.create(board('Lama'));
    const first = await buildApp({ dataDir, env, logger: false, ...quiet });
    const admin = new UserAuthStore(dataDir).findUserByEmail('admin@x.io')!;
    expect((await svc.get(loose.id))!.createdBy).toBe(admin.id);
    await first.close();
    const manifests = readdirSync(join(dataDir, 'tenancy', 'migrations'));
    const second = await buildApp({ dataDir, env, logger: false, ...quiet });
    await second.close();
    expect(readdirSync(join(dataDir, 'tenancy', 'migrations'))).toEqual(manifests);
  });

  it('TENANCY_MIGRATE=0 leaves everything alone; TENANCY_DRY_RUN=1 only reports', async () => {
    for (const flags of [{ TENANCY_MIGRATE: '0' }, { TENANCY_DRY_RUN: '1' }]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'nc-boot-'));
      const flow = new FlowStore(join(dataDir, 'flow'));
      const svc = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
      const loose = await svc.create(board('Lama'));
      const app = await buildApp({ dataDir, env: { ...env, ...flags }, logger: false, ...quiet });
      await app.close();
      expect((await svc.get(loose.id))!.createdBy).toBeUndefined();
      expect(existsSync(join(dataDir, 'tenancy'))).toBe(false);
    }
  });

  it('TENANCY_ENFORCE=1 with an unresolvable owner refuses to boot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-boot-'));
    const flow = new FlowStore(join(dataDir, 'flow'));
    const svc = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
    await svc.create(board('Lama'));
    const outcome = await buildApp({ dataDir, env: { ...env, TENANCY_ENFORCE: '1', TENANCY_DEFAULT_OWNER_EMAIL: 'tidak-ada@x.io' }, logger: false, ...quiet }).then(() => 'booted', (e: Error) => e.message);
    expect(outcome).toMatch(/TENANCY_DEFAULT_OWNER_EMAIL/);
  });
});

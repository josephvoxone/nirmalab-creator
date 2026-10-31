/**
 * W3 — the workspace migration, on a fixture that copies production: 2 accounts (Joseph admin, elfree899 member), 7 project
 * folders (6 Joseph + 1 orphan), and a spending ledger keyed by person.
 * RED first: written before `workspace/migrate.ts` existed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { ensureWorkspaces, rollbackWorkspaceMigration } from '../src/workspace/migrate.js';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const storyId = (n: number) => `story_${n.toString(16).padStart(16, '0')}`;

async function production() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-migrate-'));
  const auth = new UserAuthStore(dataDir);
  const joseph = await auth.createUser({ email: 'joseph@nirmalab.com', password: 'joseph-pass-1', isAdmin: true });
  const elfree = await auth.createUser({ email: 'elfree899@gmail.com', password: 'elfree-pass-1', isAdmin: false });
  const titles: string[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const id = storyId(i);
    const title = `Lentera ${i}`;
    mkdirSync(join(dataDir, 'stories', id), { recursive: true });
    writeFileSync(join(dataDir, 'stories', id, 'story.json'), JSON.stringify({
      id, title, createdBy: joseph.id, status: 'done', createdAtMs: 1000 + i, updatedAtMs: 2000 + i,
      scene: { lines: [`baris ${i}`] }, template: 'lentera'
    }, null, 1));
    writeFileSync(join(dataDir, 'stories', id, 'storyboard.json'), JSON.stringify({ title, shots: [{ narration: 'halo' }] }, null, 1));
    titles.push(title); ids.push(id);
  }
  // orphan: its owner account was removed months ago
  const orphanId = storyId(99);
  mkdirSync(join(dataDir, 'stories', orphanId), { recursive: true });
  writeFileSync(join(dataDir, 'stories', orphanId, 'story.json'), JSON.stringify({ id: orphanId, title: 'Yatim Lama', createdBy: 'u_gone', status: 'draft', createdAtMs: 1, updatedAtMs: 2 }, null, 1));
  mkdirSync(join(dataDir, 'quota'), { recursive: true });
  writeFileSync(join(dataDir, 'quota', 'ledger.json'), JSON.stringify({
    version: 1,
    entries: [
      { key: 'flow:1', userId: joseph.id, kind: 'flowCredits', amount: 2, state: 'committed', atMs: 10, doneAtMs: 11 },
      { key: 'flow:2', userId: joseph.id, kind: 'flowCredits', amount: 3, state: 'committed', atMs: 12, doneAtMs: 13 },
      { key: 'eleven:1', userId: elfree.id, kind: 'elevenChars', amount: 120, state: 'committed', atMs: 14, doneAtMs: 15 },
      { key: 'gone:1', userId: 'u_gone', kind: 'flowCredits', amount: 1, state: 'committed', atMs: 16, doneAtMs: 17 }
    ],
    rollup: {}
  }, null, 1));
  return { dataDir, auth, joseph, elfree, ids, titles, orphanId, store: new WorkspaceStore(dataDir) };
}

type World = Awaited<ReturnType<typeof production>>;
const readStory = (w: World, id: string) => JSON.parse(readFileSync(join(w.dataDir, 'stories', id, 'story.json'), 'utf8')) as Record<string, unknown>;
const readLedger = (w: World) => JSON.parse(readFileSync(join(w.dataDir, 'quota', 'ledger.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
const manifestFiles = (w: World) => existsSync(join(w.dataDir, 'tenancy', 'migrations')) ? readdirSync(join(w.dataDir, 'tenancy', 'migrations')).filter(n => n.endsWith('.json')) : [];

describe('W3 migrasi workspace (fixture produksi)', () => {
  it('opens one personal workspace per account, files every project under its owner, leaves the orphan without one', async () => {
    const w = await production();
    const before = Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]));
    const report = await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store });
    expect(report.dryRun).toBe(false);
    expect(report.personalWorkspaces).toHaveLength(2);
    const josephWs = w.store.personalOf(w.joseph.id)!;
    const elfreeWs = w.store.personalOf(w.elfree.id)!;
    expect(josephWs).toMatchObject({ name: 'Ruang kerja Joseph', personal: true, ownerId: w.joseph.id });
    expect(elfreeWs.name).toBe('Ruang kerja Elfree899');
    // 6 projects moved, 1 orphan untouched
    expect(report.projectsAssigned).toBe(6);
    expect(report.orphanProjects).toBe(1);
    for (const id of w.ids) {
      const story = readStory(w, id);
      expect(story.workspaceId, id).toBe(josephWs.id);
      expect(story.title, id).toBe(w.titles[w.ids.indexOf(id)]);   // title unchanged
      expect(story.createdBy, id).toBe(w.joseph.id);                // history kept
      expect(story.scene, id).toEqual({ lines: [`baris ${w.ids.indexOf(id) + 1}`] });
    }
    expect(readStory(w, w.orphanId).workspaceId).toBeUndefined();
    expect(Object.keys(readStory(w, w.orphanId)).sort()).toEqual(['createdAtMs', 'createdBy', 'id', 'title', 'updatedAtMs', 'status'].sort());
    // nothing was lost: the seven folders are still there and readable, the storyboards byte-identical
    expect(readdirSync(join(w.dataDir, 'stories')).filter(n => n.startsWith('story_'))).toHaveLength(7);
    for (const id of w.ids) expect(readFileSync(join(w.dataDir, 'stories', id, 'storyboard.json'), 'utf8')).toContain('halo');
    // only workspaceId + the two record fields were written
    for (const id of w.ids) {
      const changed = Object.keys(readStory(w, id)).sort();
      expect(changed).toEqual(['createdAtMs', 'createdBy', 'id', 'scene', 'status', 'template', 'title', 'updatedAtMs', 'workspaceAssignedAt', 'workspaceAssignedBy', 'workspaceId'].sort());
      expect(before[id]).not.toBe(sha(join(w.dataDir, 'stories', id, 'story.json')));
    }
    // backup + manifest
    expect(report.manifest).toBeDefined();
    expect(manifestFiles(w)).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest).toMatchObject({ id: 'migrasi-workspace-1', status: 'applied' });
    expect(manifest.stories).toHaveLength(6);
    for (const entry of manifest.stories) expect(existsSync(join(w.dataDir, 'tenancy', entry.backup))).toBe(true);
  });

  it('maps the ledger to the personal workspace of each owner and leaves an unknown account alone', async () => {
    const w = await production();
    const report = await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store });
    const josephWs = w.store.personalOf(w.joseph.id)!;
    const ledger = readLedger(w);
    expect(report.ledgerMapped).toBe(3);
    expect(ledger.entries.map(e => e.workspaceId)).toEqual([josephWs.id, josephWs.id, w.store.personalOf(w.elfree.id)!.id, undefined]);
    expect(ledger.entries.map(e => e.userId)).toEqual([w.joseph.id, w.joseph.id, w.elfree.id, 'u_gone']);
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest.ledger).toMatchObject({ file: 'quota/ledger.json' });
  });

  it('is idempotent: a second run changes nothing and writes no second manifest', async () => {
    const w = await production();
    await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store });
    const after = Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]));
    const ledgerSha = sha(join(w.dataDir, 'quota', 'ledger.json'));
    const again = await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store });
    expect(again.projectsAssigned).toBe(0);
    expect(again.ledgerMapped).toBe(0);
    expect(again.personalWorkspaces).toHaveLength(0);
    expect(again.manifest).toBeUndefined();
    expect(manifestFiles(w)).toHaveLength(1);
    expect(Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]))).toEqual(after);
    expect(sha(join(w.dataDir, 'quota', 'ledger.json'))).toBe(ledgerSha);
  });

  it('dry run writes nothing at all and reports what it would do', async () => {
    const w = await production();
    const before = Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]));
    const ledgerBefore = sha(join(w.dataDir, 'quota', 'ledger.json'));
    const report = await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store, dryRun: true });
    expect(report).toMatchObject({ dryRun: true, projectsAssigned: 6, orphanProjects: 1, ledgerMapped: 3 });
    expect(report.manifest).toBeUndefined();
    expect(report.personalWorkspaces).toHaveLength(2);
    expect(existsSync(join(w.dataDir, 'workspace'))).toBe(false);
    expect(manifestFiles(w)).toHaveLength(0);
    expect(Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]))).toEqual(before);
    expect(sha(join(w.dataDir, 'quota', 'ledger.json'))).toBe(ledgerBefore);
  });

  it('rolls back to byte-identical files', async () => {
    const w = await production();
    const before = Object.fromEntries([...w.ids, w.orphanId].map(id => [id, sha(join(w.dataDir, 'stories', id, 'story.json'))]));
    const ledgerBefore = sha(join(w.dataDir, 'quota', 'ledger.json'));
    const report = await ensureWorkspaces({ dataDir: w.dataDir, users: w.auth.listUsers(), store: w.store });
    const result = await rollbackWorkspaceMigration(report.manifest!);
    expect(result.restored).toHaveLength(7); // 6 stories + the ledger
    for (const id of [...w.ids, w.orphanId]) expect(sha(join(w.dataDir, 'stories', id, 'story.json')), id).toBe(before[id]);
    expect(sha(join(w.dataDir, 'quota', 'ledger.json'))).toBe(ledgerBefore);
    expect(readStory(w, w.ids[0]!).workspaceId).toBeUndefined();
  });
});

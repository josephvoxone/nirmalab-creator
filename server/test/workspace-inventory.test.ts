/**
 * W5 — `scripts/tenancy-inventory.mjs` gains a workspace summary (members per workspace, projects per workspace, living
 * projects without a title) WITHOUT changing any of its old output. RED first: written before the script knew about workspaces.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'tenancy-inventory.mjs');
const storyId = (n: number) => `story_${n.toString(16).padStart(16, '0')}`;

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-inventory-'));
  const users = [
    { id: 'u_joseph', email: 'joseph@nirmalab.com', isAdmin: true, createdAt: '2026-01-01T00:00:00.000Z', passwordHash: 'scrypt$x$y' },
    { id: 'u_elfree', email: 'elfree899@gmail.com', isAdmin: false, createdAt: '2026-02-01T00:00:00.000Z', passwordHash: 'scrypt$x$y' }
  ];
  writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({ version: 1, users, invites: [], sessions: [], removedUsers: [] }));
  mkdirSync(join(dataDir, 'workspace'), { recursive: true });
  writeFileSync(join(dataDir, 'workspace', 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [
      { id: 'ws_josephpribadi', name: 'Ruang kerja Joseph', ownerId: 'u_joseph', createdAtMs: 1, personal: true },
      { id: 'ws_timlentera', name: 'Tim Lentera', ownerId: 'u_joseph', createdAtMs: 2, personal: false }
    ],
    memberships: [
      { workspaceId: 'ws_josephpribadi', userId: 'u_joseph', role: 'owner', joinedAtMs: 1 },
      { workspaceId: 'ws_timlentera', userId: 'u_joseph', role: 'owner', joinedAtMs: 2 },
      { workspaceId: 'ws_timlentera', userId: 'u_elfree', role: 'editor', joinedAtMs: 3 }
    ],
    invites: []
  }, null, 1));
  for (let i = 1; i <= 6; i += 1) {
    const id = storyId(i);
    mkdirSync(join(dataDir, 'stories', id), { recursive: true });
    writeFileSync(join(dataDir, 'stories', id, 'story.json'), JSON.stringify({
      id, title: i === 6 ? '' : `Lentera ${i}`, createdBy: 'u_joseph', workspaceId: 'ws_josephpribadi', status: 'done', createdAtMs: 1, updatedAtMs: 2
    }, null, 1));
  }
  mkdirSync(join(dataDir, 'stories', storyId(99)), { recursive: true });
  writeFileSync(join(dataDir, 'stories', storyId(99), 'story.json'), JSON.stringify({ id: storyId(99), title: 'Yatim Lama', createdBy: 'u_gone', status: 'draft', createdAtMs: 1, updatedAtMs: 2 }, null, 1));
  return dataDir;
}

const run = (dir: string, ...args: string[]) => execFileSync(process.execPath, [SCRIPT, dir, ...args], { encoding: 'utf8' });

describe('W5 inventaris: ringkasan workspace tanpa merusak keluaran lama', () => {
  it('--json keeps every old key and adds the workspace summary', () => {
    const out = JSON.parse(run(fixture(), '--json', '--no-size'));
    for (const key of ['dataDir', 'generatedAt', 'members', 'primaryOwner', 'stories', 'perOwner', 'wouldAssign', 'publishTokens', 'mcpTokens', 'flowJobs', 'freeGenerate', 'migrations', 'problems']) {
      expect(out, key).toHaveProperty(key);
    }
    expect(out.members).toHaveLength(2);
    expect(out.stories.total).toBe(7);
    const personal = out.workspaces.perWorkspace.find((w: { id: string }) => w.id === 'ws_josephpribadi');
    const team = out.workspaces.perWorkspace.find((w: { id: string }) => w.id === 'ws_timlentera');
    expect(personal).toMatchObject({ name: 'Ruang kerja Joseph', personal: true, members: 1, projects: 6 });
    expect(team).toMatchObject({ name: 'Tim Lentera', personal: false, members: 2, projects: 0 });
    expect(out.workspaces).toMatchObject({ total: 2, personal: 1 });
    // the orphan has no workspace; six projects have one
    expect(out.workspaces.projectsWithoutWorkspace).toBe(1);
    // one living project carries no title (the orphan's title is not counted here)
    expect(out.workspaces.projectsWithoutTitle).toBe(1);
    // no token/hash of an invite ever reaches the inventory
    expect(JSON.stringify(out)).not.toContain('tokenHash');
  });

  it('the text output keeps its old lines and adds a Workspace section', () => {
    const text = run(fixture(), '--no-size');
    expect(text).toContain('Inventaris tenancy');
    expect(text).toContain('Anggota (2):');
    expect(text).toContain('Proyek: 7');
    expect(text).toContain('Ukuran per pemilik (dilewati: --no-size)');
    expect(text).toContain('YATIM');
    expect(text).toContain('Workspace');
    expect(text).toContain('Ruang kerja Joseph');
    expect(text).toContain('Tim Lentera');
    expect(text).toContain('tanpa judul');
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/tenancy-inventory.mjs', import.meta.url));
const board = (title: string): Storyboard => ({
  title, characters: {}, audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '00-a', silent: true, prompt: `RAHASIA-PROMPT ${title}`, narration: `RAHASIA-NARASI ${title}` }]
});

/** Every file under dir with size + mtime: the read-only proof compares this before and after. */
function snapshot(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) { rows.push(`D ${p}`); walk(p); } else { const s = statSync(p); rows.push(`F ${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-inv-'));
  const auth = new UserAuthStore(dataDir);
  const qa = await auth.createUser({ email: 'qa-admin@example.local', password: 'qa-pass-123', isAdmin: true });
  await new Promise(r => setTimeout(r, 4));
  const joseph = await auth.createUser({ email: 'joseph@x.io', password: 'joseph-pass-1', isAdmin: true });
  await new Promise(r => setTimeout(r, 4));
  const bob = await auth.createUser({ email: 'bob@x.io', password: 'bob-pass-123', isAdmin: false });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
  const mine = await service.create(board('JUDUL-RAHASIA-JOSEPH'), { createdBy: joseph.id });
  const loose1 = await service.create(board('JUDUL-RAHASIA-TANPA-PEMILIK-1'));
  const loose2 = await service.create(board('JUDUL-RAHASIA-TANPA-PEMILIK-2'));
  const orphan = await service.create(board('Judul Proyek Yatim'), { createdBy: 'u_sudah_dihapus' });
  const qaOwned = await service.create(board('JUDUL-RAHASIA-QA'), { createdBy: qa.id });
  const bobs = await service.create(board('JUDUL-RAHASIA-BOB'), { createdBy: bob.id });
  writeFileSync(join(service.storyDir(mine.id), 'final.mp4'), Buffer.alloc(5000, 1));
  writeFileSync(join(service.storyDir(bobs.id), 'final.mp4'), Buffer.alloc(1200, 1));
  writeFileSync(join(service.storyDir(orphan.id), 'final.mp4'), Buffer.alloc(700, 1));
  // a clip hard-linked into two stories counts once
  mkdirSync(join(dataDir, 'flow', 'clips'), { recursive: true });
  writeFileSync(join(dataDir, 'flow', 'clips', 'job_0123456789abcdef.mp4'), Buffer.alloc(3000, 2));
  (await import('node:fs')).linkSync(join(dataDir, 'flow', 'clips', 'job_0123456789abcdef.mp4'), join(service.storyDir(mine.id), '00-a.mp4'));
  (await import('node:fs')).linkSync(join(dataDir, 'flow', 'clips', 'job_0123456789abcdef.mp4'), join(service.storyDir(bobs.id), '00-a.mp4'));
  // global publish tokens (secrets must never be printed) and MCP tokens
  mkdirSync(join(dataDir, 'publisher'), { recursive: true });
  writeFileSync(join(dataDir, 'publisher', 'youtube.json'), JSON.stringify({ accessToken: 'ya29.RAHASIA-TOKEN', refreshToken: 'REFRESH-RAHASIA' }));
  mkdirSync(join(dataDir, 'mcp'), { recursive: true });
  writeFileSync(join(dataDir, 'mcp', 'tokens.json'), JSON.stringify({ version: 1, tokens: [
    { id: 'm1', userId: joseph.id, name: 'NAMA-TOKEN-RAHASIA', sha256: 'ab'.repeat(32), createdAt: 'x', lastUsedAt: null },
    { id: 'm2', userId: joseph.id, name: 'kedua', sha256: 'cd'.repeat(32), createdAt: 'x', lastUsedAt: null },
    { id: 'm3', userId: 'u_sudah_dihapus', name: 'yatim', sha256: 'ef'.repeat(32), createdAt: 'x', lastUsedAt: null }
  ] }));
  writeFileSync(join(dataDir, 'flow', 'flow.json'), JSON.stringify({ version: 1, accounts: [], jobs: [
    { id: 'job_1', prompt: 'RAHASIA-PROMPT-JOB', technique: `story:${mine.id}/00-a`, createdBy: joseph.id },
    { id: 'job_2', prompt: 'p', technique: `story:${loose1.id}/00-a` },
    { id: 'job_3', prompt: 'p', technique: 'cover:drama-hewan' },
    { id: 'job_4', prompt: 'p', technique: 'studio' }
  ] }));
  return { dataDir, joseph, bob, qa, ids: { mine: mine.id, loose1: loose1.id, loose2: loose2.id, orphan: orphan.id, qaOwned: qaOwned.id, bobs: bobs.id } };
}

const run = (args: string[]) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TENANCY_DEFAULT_OWNER_EMAIL: '' } });

describe('T1 scripts/tenancy-inventory.mjs (read-only, production-safe)', () => {
  it('counts ownerless projects, orphans, members, tokens and bytes per owner', async () => {
    const w = await world();
    const out = JSON.parse(run([w.dataDir, '--json']));
    expect(out.members.map((m: { email: string }) => m.email).sort()).toEqual(['bob@x.io', 'joseph@x.io', 'qa-admin@example.local']);
    expect(out.members.find((m: { email: string }) => m.email === 'joseph@x.io')).toMatchObject({ isAdmin: true, qa: false });
    expect(out.members.find((m: { email: string }) => m.email === 'qa-admin@example.local')).toMatchObject({ qa: true });
    expect(out.primaryOwner).toMatchObject({ email: 'joseph@x.io', via: 'oldest-admin' });
    expect(out.stories).toMatchObject({ total: 6, withOwner: 4, withoutOwner: 2, unreadable: [] });
    expect(out.stories.orphans).toEqual([{ id: w.ids.orphan, title: 'Judul Proyek Yatim', ownerId: 'u_sudah_dihapus', bytes: expect.any(Number) }]);
    expect(out.stories.qaOwned).toEqual([{ id: w.ids.qaOwned, ownerId: w.qa.id }]);
    expect(out.wouldAssign).toBe(2);
    const bytes = (ownerId: string) => out.perOwner.find((o: { ownerId: string }) => o.ownerId === ownerId);
    expect(bytes(w.joseph.id)).toMatchObject({ email: 'joseph@x.io', projects: 1 });
    expect(bytes(w.bob.id)).toMatchObject({ projects: 1 });
    expect(out.perOwner.find((o: { ownerId: string }) => o.ownerId === null)).toMatchObject({ projects: 2 });
    // the hard-linked clip (3000 B) is counted once, in the first story that holds it
    const total = out.perOwner.reduce((sum: number, o: { bytes: number }) => sum + o.bytes, 0);
    expect(out.perOwner.find((o: { ownerId: string }) => o.ownerId === w.joseph.id).bytes + out.perOwner.find((o: { ownerId: string }) => o.ownerId === w.bob.id).bytes).toBeGreaterThanOrEqual(5000 + 1200 + 3000);
    expect(out.perOwner.find((o: { ownerId: string }) => o.ownerId === w.joseph.id).bytes + out.perOwner.find((o: { ownerId: string }) => o.ownerId === w.bob.id).bytes).toBeLessThan(5000 + 1200 + 3000 + 3000);
    expect(total).toBeGreaterThan(0);
    expect(out.publishTokens.global).toEqual([{ platform: 'youtube' }]);
    expect(out.mcpTokens).toMatchObject({ total: 3, withoutLiveOwner: 1 });
    expect(out.mcpTokens.perUser).toEqual([{ userId: w.joseph.id, email: 'joseph@x.io', count: 2 }]);
    expect(out.flowJobs).toMatchObject({ total: 4, withoutCreatedBy: 3, byKind: { story: 1, cover: 1, studio: 1 } });
  });

  it('prints NO project title, prompt, narration, token or secret — only the orphan\'s title', async () => {
    const w = await world();
    for (const args of [[w.dataDir], [w.dataDir, '--json']]) {
      const out = run(args);
      expect(out).not.toMatch(/RAHASIA/);
      expect(out).not.toMatch(/JUDUL-RAHASIA/);
      expect(out).not.toMatch(/passwordHash|scrypt|ya29|REFRESH/);
      expect(out).toContain('Judul Proyek Yatim');
      expect(out).toContain(w.ids.orphan);
    }
  });

  it('is read-only: the data directory is identical (names, sizes, mtimes) after a run, and no tenancy/ appears', async () => {
    const w = await world();
    const before = snapshot(w.dataDir);
    run([w.dataDir]);
    run([w.dataDir, '--json']);
    run([w.dataDir, '--no-size']);
    expect(snapshot(w.dataDir)).toBe(before);
    expect(readdirSync(w.dataDir)).not.toContain('tenancy');
  });

  it('honours the default-owner email (env or flag), says so when it matches nobody, and survives a corrupt story.json and a missing data dir', async () => {
    const w = await world();
    const viaFlag = JSON.parse(run([w.dataDir, '--json', '--owner-email=bob@x.io']));
    expect(viaFlag.primaryOwner).toMatchObject({ email: 'bob@x.io', via: 'env' });
    const none = JSON.parse(run([w.dataDir, '--json', '--owner-email=ghost@x.io']));
    expect(none.primaryOwner).toBeNull();
    expect(none.problems.join(' ')).toMatch(/TENANCY_DEFAULT_OWNER_EMAIL/);
    writeFileSync(join(w.dataDir, 'stories', w.ids.bobs, 'story.json'), '{ broken');
    const broken = JSON.parse(run([w.dataDir, '--json']));
    expect(broken.stories.unreadable).toEqual([w.ids.bobs]);
    const empty = JSON.parse(run([join(w.dataDir, 'nope'), '--json']));
    expect(empty.stories.total).toBe(0);
    expect(empty.problems.join(' ')).toMatch(/tidak ada|not found|tidak ditemukan/i);
  });

  it('after ensureOwners the same inventory shows zero ownerless projects (the before/after check the owner reads)', async () => {
    const w = await world();
    const { ensureOwners } = await import('../src/tenancy/migrate.js');
    const users = new UserAuthStore(w.dataDir).listUsers();
    await ensureOwners({ dataDir: w.dataDir, users });
    const out = JSON.parse(run([w.dataDir, '--json']));
    expect(out.stories.withoutOwner).toBe(0);
    expect(out.wouldAssign).toBe(0);
    expect(out.migrations).toHaveLength(1);
  });
});

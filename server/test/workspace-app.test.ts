/**
 * W4/W3 wiring over HTTP: a boot on a data dir that already holds accounts and projects gives every existing account a personal
 * workspace, files the old projects under it, and the sidebar route (GET /api/workspaces) reports it. Mirrors production (2 people).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';

const storyId = (n: number) => `story_${n.toString(16).padStart(16, '0')}`;

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-app-'));
  const auth = new UserAuthStore(dataDir);
  const joseph = await auth.createUser({ email: 'joseph@nirmalab.com', password: 'joseph-pass-1', isAdmin: true });
  const elfree = await auth.createUser({ email: 'elfree899@gmail.com', password: 'elfree-pass-1', isAdmin: false });
  for (const n of [1, 2]) {
    const id = storyId(n);
    mkdirSync(join(dataDir, 'stories', id), { recursive: true });
    writeFileSync(join(dataDir, 'stories', id, 'story.json'), JSON.stringify({ id, title: `Lentera ${n}`, createdBy: joseph.id, status: 'draft', createdAtMs: 1, updatedAtMs: 2 }, null, 1));
  }
  const webDist = mkdtempSync(join(tmpdir(), 'nc-ws-app-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  return { dataDir, webDist, joseph, elfree, auth };
}

describe('W3/W4 boot: pengguna lama mendapat workspace pribadi dan proyeknya terbaca di sana', () => {
  it('a boot on an existing data dir files the old projects under the personal workspace of their owner', async () => {
    const f = await fixture();
    const server = await buildApp({
      dataDir: f.dataDir, webDist: f.webDist, env: {}, logger: false,
      stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 }
    });
    const session = f.auth.createSession(f.joseph.id).token;
    const res = await server.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: `oc_session=${session}` } });
    expect(res.statusCode).toBe(200);
    const list = res.json().workspaces as Array<{ id: string; name: string; role: string; personal: boolean; projects: number; members: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Ruang kerja Joseph', role: 'owner', personal: true, projects: 2, members: 1 });
    // the projects really carry that workspace in story.json (title and owner untouched)
    for (const n of [1, 2]) {
      const record = JSON.parse(readFileSync(join(f.dataDir, 'stories', storyId(n), 'story.json'), 'utf8'));
      expect(record).toMatchObject({ title: `Lentera ${n}`, createdBy: f.joseph.id, workspaceId: list[0]!.id });
    }
    // the other member got one too (empty)
    const elfreeSession = f.auth.createSession(f.elfree.id).token;
    const theirs = await server.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: `oc_session=${elfreeSession}` } });
    expect(theirs.json().workspaces).toEqual([expect.objectContaining({ name: 'Ruang kerja Elfree899', projects: 0 })]);
    // and the sign-in itself opens the personal workspace on first use
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'elfree899@gmail.com', password: 'elfree-pass-1' } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeDefined();
    await server.close();
  });
});

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { cleanupStorage, measureStorage, registerStorageRoutes } from '../src/media/storage.js';
import { setupApp } from './media-helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12);
const J = (n: number) => `job_${String(n).padStart(16, '0')}`;

function put(root: string, rel: string, bytes: number | Buffer, ageMs = 0): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof bytes === 'number' ? Buffer.alloc(bytes, 1) : bytes);
  const at = (NOW - ageMs) / 1000;
  utimesSync(file, at, at);
  return file;
}

const sameFile = (a: string, b: string) => statSync(a).ino === statSync(b).ino && statSync(a).dev === statSync(b).dev;

describe('measureStorage', () => {
  it('sums by area and counts a hard-linked file once (in clips)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nc-measure-'));
    const clip = put(root, `flow/clips/${J(1)}.mp4`, 5000);
    mkdirSync(join(root, 'stories/story_aaaaaaaaaaaaaaaa'), { recursive: true });
    linkSync(clip, join(root, 'stories/story_aaaaaaaaaaaaaaaa/01-a.mp4'));
    put(root, 'stories/story_aaaaaaaaaaaaaaaa/story.json', 100);
    put(root, 'cache/img/x.webp', 300);
    put(root, 'covers/drama-hewan.img', 400);
    put(root, 'flow/flow.json', 50);
    put(root, 'runtime/thing.bin', 70);
    const m = await measureStorage(root);
    expect(m.byArea).toEqual({ stories: 100, clips: 5000, cache: 300, covers: 400, other: 120 });
    expect(m.usedBytes).toBe(5920);
    expect(typeof m.diskFreeBytes).toBe('number');
    expect(m.diskFreeBytes!).toBeGreaterThan(0);
  });

  it('an empty or missing data dir is zero', async () => {
    const m = await measureStorage(join(tmpdir(), 'nc-does-not-exist-' + Date.now()));
    expect(m.usedBytes).toBe(0);
    expect(m.byArea).toEqual({ stories: 0, clips: 0, cache: 0, covers: 0, other: 0 });
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nc-clean-'));
  const old = 40 * DAY;
  const S = 'stories/story_aaaaaaaaaaaaaaaa';
  const f = {
    root,
    done: put(root, `flow/clips/${J(1)}.mp4`, Buffer.alloc(6000, 7), old),
    failed: put(root, `flow/clips/${J(2)}.mp4`, 3000, old),
    missing: put(root, `flow/clips/${J(3)}.png`, 2000, old),
    linkedMissing: put(root, `flow/clips/${J(4)}.mp4`, 1500, old),
    namedFailed: put(root, `flow/clips/${J(5)}.mp4`, 1200, old),
    fresh: put(root, `flow/clips/${J(6)}.mp4`, 1100, 5 * 60_000),
    other: put(root, 'flow/clips/notes.txt', 900, old),
    prev: put(root, `${S}/final.mp4.prev`, 4000),
    final: put(root, `${S}/final.mp4`, 4500),
    duplicate: put(root, `${S}/01-a.mp4`, Buffer.alloc(6000, 7)),
    sameSizeOther: put(root, `${S}/02-b.mp4`, Buffer.alloc(6000, 8)),
    busyPrev: put(root, 'stories/story_bbbbbbbbbbbbbbbb/final.mp4.prev', 800),
    oldCache: put(root, 'cache/img/aaaa.webp', 700, 31 * DAY),
    newCache: put(root, 'cache/img/bbbb.webp', 600, 29 * DAY),
    oldTrend: put(root, 'trends/cache/ID-24h-semua.json', 500, 31 * DAY),
    newTrend: put(root, 'trends/cache/US-7h-ai.json', 400, 1 * DAY)
  };
  mkdirSync(join(root, S), { recursive: true });
  linkSync(f.linkedMissing, join(root, S, '03-c.mp4'));
  writeFileSync(join(root, S, 'story.json'), JSON.stringify({ id: 'story_aaaaaaaaaaaaaaaa', status: 'done', shots: [{ id: '04-d', jobId: J(5) }] }));
  writeFileSync(join(root, 'stories/story_bbbbbbbbbbbbbbbb/story.json'), JSON.stringify({ id: 'story_bbbbbbbbbbbbbbbb', status: 'assembling', shots: [] }));
  const jobs = [{ id: J(1), status: 'done' as const }, { id: J(2), status: 'failed' as const }, { id: J(5), status: 'failed' as const }];
  return { ...f, jobs };
}

describe('cleanupStorage', () => {
  it('removes .prev, stale cache and orphan clips; links duplicates; reports freed bytes', async () => {
    const f = fixture();
    const res = await cleanupStorage(f.root, { jobs: async () => f.jobs, now: () => NOW });
    // Removed: failed-job clip, missing-job clip, final.mp4.prev, 31-day cache.
    for (const gone of [f.failed, f.missing, f.prev, f.oldCache, f.oldTrend]) expect(existsSync(gone), gone).toBe(false);
    expect(res.removed).toBe(5);
    // Kept: done job, story-linked, story-referenced, fresh (in-flight), foreign names, the live cut, a busy story's backup, fresh cache.
    for (const kept of [f.done, f.linkedMissing, f.namedFailed, f.fresh, f.other, f.final, f.busyPrev, f.newCache, f.newTrend]) expect(existsSync(kept), kept).toBe(true);
    // The byte-identical story copy now shares the clip's inode; a same-size different file does not.
    expect(sameFile(f.duplicate, f.done)).toBe(true);
    expect(readFileSync(f.duplicate).equals(Buffer.alloc(6000, 7))).toBe(true);
    expect(sameFile(f.sameSizeOther, f.done)).toBe(false);
    expect(res.linked).toBe(1);
    expect(res.freedBytes).toBe(3000 + 2000 + 4000 + 700 + 6000 + 500);
  });

  it('keeps clips an undo snapshot points to; removes chat uploads nothing refers to after 7 days', async () => {
    const f = fixture();
    const S = 'stories/story_aaaaaaaaaaaaaaaa';
    const U = (n: number) => `up_${String(n).padStart(16, '0')}`;
    // A paid take only an undo snapshot remembers (its job record pruned): undo must still find it.
    const snapClip = put(f.root, `flow/clips/${J(7)}.mp4`, 2500, 40 * DAY);
    put(f.root, `${S}/snapshots/u_aaaaaaaaaaaaaaaa_1_0001.json`, Buffer.from(JSON.stringify({ record: { shots: [{ id: '05-e', status: 'done', jobId: J(7) }] } })));
    const stray = put(f.root, `${S}/uploads/${U(1)}.png`, 800, 8 * DAY);
    const sent = put(f.root, `${S}/uploads/${U(2)}.png`, 800, 8 * DAY);
    const card = put(f.root, `${S}/uploads/${U(3)}.jpg`, 800, 8 * DAY);
    const recent = put(f.root, `${S}/uploads/${U(4)}.webp`, 800, 2 * DAY);
    const inSnapshot = put(f.root, `${S}/uploads/${U(5)}.png`, 800, 8 * DAY);
    writeFileSync(join(f.root, S, 'assistant.json'), JSON.stringify({ turns: [{ role: 'user', attachments: [{ id: U(2) }] }] }));
    writeFileSync(join(f.root, S, 'storyboard.json'), JSON.stringify({ bible: { characters: [{ token: 'A', reference: `uploads/${U(3)}.jpg` }] } }));
    put(f.root, `${S}/snapshots/u_aaaaaaaaaaaaaaaa_2_0002.json`, Buffer.from(JSON.stringify({ storyboard: { shots: [{ startFrame: `uploads/${U(5)}.png` }] } })));

    await cleanupStorage(f.root, { jobs: async () => f.jobs, now: () => NOW });
    expect(existsSync(snapClip)).toBe(true);
    expect(existsSync(stray)).toBe(false);
    for (const kept of [sent, card, recent, inSnapshot]) expect(existsSync(kept), kept).toBe(true);
  });

  it('is idempotent: a second run frees nothing', async () => {
    const f = fixture();
    await cleanupStorage(f.root, { jobs: async () => f.jobs, now: () => NOW });
    expect(await cleanupStorage(f.root, { jobs: async () => f.jobs, now: () => NOW })).toEqual({ freedBytes: 0, linked: 0, removed: 0 });
  });

  it('measured usage drops by exactly the freed bytes', async () => {
    const f = fixture();
    const before = await measureStorage(f.root);
    const res = await cleanupStorage(f.root, { jobs: async () => f.jobs, now: () => NOW });
    expect(before.usedBytes - (await measureStorage(f.root)).usedBytes).toBe(res.freedBytes);
  });

  it('an empty job list never deletes clips (unreadable flow.json must not wipe the library)', async () => {
    const f = fixture();
    await cleanupStorage(f.root, { jobs: async () => [], now: () => NOW });
    for (const kept of [f.done, f.failed, f.missing]) expect(existsSync(kept), kept).toBe(true);
    expect(existsSync(f.prev)).toBe(false);
  });

  it('a failing job read fails the run instead of guessing', async () => {
    const f = fixture();
    await expect(cleanupStorage(f.root, { jobs: async () => { throw new Error('flow.json locked'); }, now: () => NOW })).rejects.toThrow(/locked/);
    expect(existsSync(f.failed)).toBe(true);
  });
});

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('storage routes', () => {
  async function routes() {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-storage-routes-'));
    put(dataDir, 'cache/img/x.webp', 300);
    const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-storage-auth-')));
    const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
    const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
    let runs = 0;
    server = Fastify();
    await registerStorageRoutes(server, { userAuthStore: auth, dataDir, cleanup: async () => { runs++; return { freedBytes: 12, linked: 1, removed: 2 }; } });
    await server.ready();
    return {
      admin: `oc_session=${auth.createSession(admin.id).token}`,
      member: `oc_session=${auth.createSession(member.id).token}`,
      runs: () => runs
    };
  }

  it('GET /api/storage and POST /api/storage/cleanup are admin-only', async () => {
    const t = await routes();
    expect((await server!.inject('/api/storage')).statusCode).toBe(401);
    expect((await server!.inject({ url: '/api/storage', headers: { cookie: t.member } })).statusCode).toBe(403);
    expect((await server!.inject({ method: 'POST', url: '/api/storage/cleanup' })).statusCode).toBe(401);
    expect((await server!.inject({ method: 'POST', url: '/api/storage/cleanup', headers: { cookie: t.member } })).statusCode).toBe(403);
    expect(t.runs()).toBe(0);
  });

  it('admin: GET returns measureStorage, POST runs cleanup and returns its result', async () => {
    const t = await routes();
    const got = await server!.inject({ url: '/api/storage', headers: { cookie: t.admin } });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ usedBytes: 300, byArea: { cache: 300, stories: 0, clips: 0, covers: 0, other: 0 } });
    const run = await server!.inject({ method: 'POST', url: '/api/storage/cleanup', headers: { cookie: t.admin } });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toEqual({ freedBytes: 12, linked: 1, removed: 2 });
    expect(t.runs()).toBe(1);
  });

  it('wired into the app: admin sees storage and can run a real cleanup', async () => {
    const t = await setupApp();
    put(t.dataDir, 'stories/' + t.storyId + '/final.mp4.prev', 2500);
    const got = await t.server.inject({ url: '/api/storage', headers: { cookie: t.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.json().byArea.stories).toBeGreaterThanOrEqual(2500);
    const run = await t.server.inject({ method: 'POST', url: '/api/storage/cleanup', headers: { cookie: t.cookie } });
    expect(run.json()).toMatchObject({ removed: 1, freedBytes: 2500 });
    await t.server.close();
  });

  it('the server sweeps on its own timer', async () => {
    const t = await setupApp({ media: { cleanupMs: 40 } });
    const prev = put(t.dataDir, 'stories/' + t.storyId + '/final.mp4.prev', 2500);
    // story.json says draft → the backup is stale.
    for (let i = 0; i < 50 && existsSync(prev); i++) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(prev)).toBe(false);
    await t.server.close();
  });
});

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { backfillJobOwners, rollbackJobBackfill } from '../src/flow/backfill.js';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const board = (title: string): Storyboard => ({
  title, characters: {}, audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' }]
});
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const without = (job: FlowJob) => { const { createdBy: _c, ...rest } = job; return rest; };

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobs-bf-'));
  const auth = new UserAuthStore(dataDir);
  const joseph = await auth.createUser({ email: 'joseph@x.io', password: 'joseph-pass-1', isAdmin: true });
  const bob = await auth.createUser({ email: 'bob@x.io', password: 'bob-pass-123', isAdmin: false });
  const store = new FlowStore(join(dataDir, 'flow'));
  await store.addAccount({ label: 'Akun', email: 'a@x' });
  const stories = new StoryService({ dataDir, flow: store, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
  const A = await stories.create(board('Proyek Joseph'), { createdBy: joseph.id });
  const E = await stories.create(board('Proyek Bob'), { createdBy: bob.id });
  const C = await stories.create(board('Proyek yatim'), { createdBy: 'u_sudah_dihapus' });
  const job = (extra: Partial<Parameters<FlowStore['createJob']>[0]>) => store.createJob({ prompt: 'p', kind: 'image', ...extra });
  const ids = {
    storyA: (await job({ group: A.id, technique: `story:${A.id}/01` })).id,
    storyE: (await job({ group: E.id, technique: `story:${E.id}/cast:rina` })).id,
    storyC: (await job({ group: C.id, technique: `story:${C.id}/01` })).id,
    gone: (await job({ group: 'story_aaaaaaaaaaaaaaaa', technique: 'story:story_aaaaaaaaaaaaaaaa/01' })).id,
    cover: (await job({ technique: 'cover:horor' })).id,
    studio: (await job({ technique: 'Sinematik' })).id,
    studioBare: (await job({})).id,
    owned: (await job({ createdBy: bob.id })).id
  };
  return { dataDir, store, stories, joseph, bob, A, E, C, ids };
}
const flowJson = (dir: string) => join(dir, 'flow', 'flow.json');
const run = (w: Awaited<ReturnType<typeof world>>, extra: Partial<Parameters<typeof backfillJobOwners>[0]> = {}) =>
  backfillJobOwners({ dataDir: w.dataDir, store: w.store, ownerOfStory: id => w.stories.ownerOf(id), mainOwnerId: w.joseph.id, ...extra });

describe('T4-4: backfill createdBy on jobs that have none', () => {
  it('story jobs -> the project\'s owner (orphans keep the dead owner id, missing projects -> main owner), Studio -> main owner, covers -> system:cover; owned jobs untouched', async () => {
    const w = await world();
    const report = await run(w);
    const owners = Object.fromEntries(await Promise.all(Object.entries(w.ids).map(async ([k, id]) => [k, (await w.store.getJob(id))?.createdBy])));
    expect(owners).toEqual({
      storyA: w.joseph.id, storyE: w.bob.id, storyC: 'u_sudah_dihapus', gone: w.joseph.id,
      cover: 'system:cover', studio: w.joseph.id, studioBare: w.joseph.id, owned: w.bob.id
    });
    expect(report.assigned).toHaveLength(7);
    expect(report.unassigned).toEqual([]);
    expect(existsSync(report.manifest!)).toBe(true);
  });

  it('changes nothing but createdBy: every other job field, the job order, accounts and the project files stay byte-identical', async () => {
    const w = await world();
    const before = JSON.parse(readFileSync(flowJson(w.dataDir), 'utf8')) as { jobs: FlowJob[]; accounts: unknown };
    const storyBytes = sha(readFileSync(join(w.stories.storyDir(w.A.id), 'story.json')));
    await run(w);
    const after = JSON.parse(readFileSync(flowJson(w.dataDir), 'utf8')) as { jobs: FlowJob[]; accounts: unknown };
    expect(after.jobs.map(j => j.id)).toEqual(before.jobs.map(j => j.id));
    expect(after.jobs.map(without)).toEqual(before.jobs.map(without));
    expect(after.accounts).toEqual(before.accounts);
    expect(sha(readFileSync(join(w.stories.storyDir(w.A.id), 'story.json')))).toBe(storyBytes);
  });

  it('keeps the previous flow.json as a backup and a manifest of every assignment', async () => {
    const w = await world();
    const original = readFileSync(flowJson(w.dataDir));
    const report = await run(w);
    const manifest = JSON.parse(readFileSync(report.manifest!, 'utf8'));
    expect(manifest.status).toBe('applied');
    expect(manifest.entries).toHaveLength(7);
    expect(manifest.entries[0]).toMatchObject({ before: null });
    const backup = join(w.dataDir, 'tenancy', manifest.backup);
    expect(sha(readFileSync(backup))).toBe(sha(original));
  });

  it('is idempotent: a second run assigns nothing, writes no manifest and leaves flow.json untouched', async () => {
    const w = await world();
    await run(w);
    const bytes = sha(readFileSync(flowJson(w.dataDir)));
    const manifests = readdirSync(join(w.dataDir, 'tenancy', 'migrations'));
    const again = await run(w);
    expect(again.assigned).toEqual([]);
    expect(again.manifest).toBeUndefined();
    expect(sha(readFileSync(flowJson(w.dataDir)))).toBe(bytes);
    expect(readdirSync(join(w.dataDir, 'tenancy', 'migrations'))).toEqual(manifests);
  });

  it('dry run reports the plan and writes nothing; without a main owner only owner-derived jobs are assigned', async () => {
    const w = await world();
    const bytes = sha(readFileSync(flowJson(w.dataDir)));
    const dry = await run(w, { dryRun: true });
    expect(dry.assigned).toHaveLength(7);
    expect(sha(readFileSync(flowJson(w.dataDir)))).toBe(bytes);
    expect(existsSync(join(w.dataDir, 'tenancy'))).toBe(false);
    const none = await run(w, { mainOwnerId: undefined });
    expect(none.unassigned.sort()).toEqual([w.ids.gone, w.ids.studio, w.ids.studioBare].sort());
    expect(none.assigned).toHaveLength(4);
  });

  it('rollback removes exactly what the run added (and nothing a person set later)', async () => {
    const w = await world();
    const original = JSON.parse(readFileSync(flowJson(w.dataDir), 'utf8'));
    const report = await run(w);
    const undone = await rollbackJobBackfill(report.manifest!, w.store);
    expect(undone.reverted).toHaveLength(7);
    expect(JSON.parse(readFileSync(flowJson(w.dataDir), 'utf8'))).toEqual(original);
    expect((await w.store.getJob(w.ids.owned))?.createdBy).toBe(w.bob.id);
    expect((await rollbackJobBackfill(report.manifest!, w.store)).reverted).toEqual([]);
  });
});

describe('T4-4: the backfill runs at boot (buildApp)', () => {
  const ENV = { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' };
  async function boot(extraEnv: Record<string, string> = {}) {
    const { buildApp } = await import('../src/app.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'jobs-bf-app-'));
    const seed = new FlowStore(join(dataDir, 'flow'));
    const studio = await seed.createJob({ prompt: 'ombak Studio', kind: 'image' });
    const cover = await seed.createJob({ prompt: 'cover', kind: 'image', technique: 'cover:horor' });
    const server = await buildApp({ dataDir, env: { ...ENV, ...extraEnv }, logger: false, stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 } });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    return { server, dataDir, studio, cover, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  }

  it('Studio jobs without an owner become the admin\'s, covers become system:cover, and the admin\'s own list shows exactly the Studio job', async () => {
    const t = await boot();
    const stored = JSON.parse(readFileSync(join(t.dataDir, 'flow', 'flow.json'), 'utf8')) as { jobs: FlowJob[] };
    const byId = new Map(stored.jobs.map(j => [j.id, j]));
    expect(byId.get(t.studio.id)?.createdBy).toBeTruthy();
    expect(byId.get(t.cover.id)?.createdBy).toBe('system:cover');
    const list = await t.server.inject({ url: '/api/flow/jobs', headers: { cookie: t.cookie } });
    expect((list.json().jobs as Array<{ id: string }>).map(j => j.id)).toEqual([t.studio.id]);
    expect(readdirSync(join(t.dataDir, 'tenancy', 'migrations')).some(n => n.endsWith('-jobs.json'))).toBe(true);
    await t.server.close();
  });

  it('TENANCY_MIGRATE=0 writes nothing, and the same ownerless job is still the main owner\'s to read', async () => {
    const t = await boot({ TENANCY_MIGRATE: '0' });
    const stored = JSON.parse(readFileSync(join(t.dataDir, 'flow', 'flow.json'), 'utf8')) as { jobs: FlowJob[] };
    expect(stored.jobs.every(j => !j.createdBy)).toBe(true);
    const list = await t.server.inject({ url: '/api/flow/jobs', headers: { cookie: t.cookie } });
    expect((list.json().jobs as Array<{ id: string }>).map(j => j.id)).toEqual([t.studio.id]);
    await t.server.close();
  });
});

describe('T4-4: FlowStore.assignCreatedBy is compare-and-set', () => {
  it('never replaces an owner somebody set meanwhile, and clearCreatedBy only removes what the backfill wrote', async () => {
    const w = await world();
    const done = await w.store.assignCreatedBy({ [w.ids.owned]: 'u_intruder', [w.ids.studio]: 'u_new' });
    expect(done).toEqual([{ id: w.ids.studio, after: 'u_new' }]);
    expect((await w.store.getJob(w.ids.owned))?.createdBy).toBe(w.bob.id);
    expect(await w.store.clearCreatedBy([{ id: w.ids.owned, after: 'u_intruder' }, { id: w.ids.studio, after: 'u_other' }])).toEqual([]);
    expect(await w.store.clearCreatedBy([{ id: w.ids.studio, after: 'u_new' }])).toEqual([w.ids.studio]);
  });
});

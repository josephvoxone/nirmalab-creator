import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryError, StoryService } from '../src/stories/service.js';
import { hashFor, type Storyboard } from '../src/stories/storyboard.js';

const A = 'u_alice';
const B = 'u_bob';
const own = (title: string): Storyboard => ({
  title, characters: {}, audio: 'Audio: "{line}"', audioSilent: 'Audio: wind.',
  shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' }]
});
const withReuse = (title: string, jobId: string, start?: number): Storyboard => ({
  ...own(title),
  shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' }, { id: '01-reuse', prompt: '', reuse: { jobId, ...(start === undefined ? {} : { start }) } }]
});

function setup(legacyOwnerId?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-reuse-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }),
    assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1)); },
    ...(legacyOwnerId ? { legacyOwnerId: () => legacyOwnerId } : {})
  });
  return { dataDir, flow, service };
}
type T = ReturnType<typeof setup>;

/** A finished Flow clip made for `createdBy` (what the bridge leaves behind). */
async function finishedClip(t: T, input: { createdBy?: string; group?: string } = {}) {
  const job = await t.flow.createJob({ prompt: 'a castle', durationSec: 6, ...input });
  await t.flow.claimJob('mac');
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${job.id}.mp4`);
  writeFileSync(file, Buffer.alloc(4096, 9));
  await t.flow.completeJob(job.id, { filePath: file, bytes: 4096 });
  return { id: job.id, file };
}
const clipOf = (t: T, storyId: string) => join(t.service.storyDir(storyId), '01-reuse.mp4');

/** Save a board the way an older build would have (no ownership check): straight into storyboard.json. */
function plant(t: T, id: string, board: Storyboard) {
  const dir = t.service.storyDir(id);
  writeFileSync(join(dir, 'storyboard.json'), JSON.stringify({ ...board, slug: id }, null, 1));
}

describe('HOTFIX T3-reuse: shot.reuse.jobId only takes clips the story owner may use', () => {
  it('PoC from the audit: B cannot save a board that reuses A\'s clip, and no copy of A\'s clip ever reaches B\'s project', async () => {
    const t = setup();
    const stolen = await finishedClip(t, { createdBy: A });
    const error = await t.service.create(withReuse('Punya B', stolen.id), { createdBy: B }).catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).code).toBe('INVALID');
    expect((error as StoryError).message).toMatch(/dipakai ulang/);
    expect((error as StoryError).message).toMatch(/milik Anda/);
    expect((await t.service.listFor(B))).toEqual([]);
  });

  it('a board that already holds a foreign reuse (saved by an older build) is refused at render: shot fails, nothing is copied', async () => {
    const t = setup();
    const stolen = await finishedClip(t, { createdBy: A });
    const mine = await t.service.create(own('Punya B'), { createdBy: B });
    plant(t, mine.id, withReuse('Punya B', stolen.id));
    // keep the record's shot list in step with the planted board, as updateStoryboard would have
    const rec = JSON.parse(readFileSync(join(t.service.storyDir(mine.id), 'story.json'), 'utf8'));
    rec.shots.push({ id: '01-reuse', status: 'pending', attempts: 0 });
    writeFileSync(join(t.service.storyDir(mine.id), 'story.json'), JSON.stringify(rec, null, 1));
    await t.service.render(mine.id);
    await t.service.reconcile(mine.id);
    const after = (await t.service.get(mine.id))!;
    const shot = after.shots.find(s => s.id === '01-reuse')!;
    expect(shot.status).toBe('failed');
    expect(shot.error).toMatch(/tidak tersedia untuk dipakai ulang/);
    expect(existsSync(clipOf(t, mine.id))).toBe(false);
  });

  it('updateStoryboard refuses to ADD a foreign reuse and leaves the stored board untouched', async () => {
    const t = setup();
    const stolen = await finishedClip(t, { createdBy: A });
    const mine = await t.service.create(own('Punya B'), { createdBy: B });
    const before = readFileSync(join(t.service.storyDir(mine.id), 'storyboard.json'), 'utf8');
    const error = await t.service.updateStoryboard(mine.id, withReuse('Punya B', stolen.id)).catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).code).toBe('INVALID');
    expect((error as StoryError).message).toMatch(/01-reuse/);
    expect(readFileSync(join(t.service.storyDir(mine.id), 'storyboard.json'), 'utf8')).toBe(before);
    expect((await t.service.get(mine.id))!.rev).toBe(1);
  });

  it('legitimate reuse keeps working: own job, own other story\'s job, and the story\'s own job', async () => {
    const t = setup();
    const bobsClip = await finishedClip(t, { createdBy: B });
    const first = await t.service.create(own('Pertama'), { createdBy: B });
    const viaGroup = await finishedClip(t, { group: first.id });           // job of another story of the same owner (no createdBy on the job)
    const later = await t.service.create(withReuse('Kedua', bobsClip.id, 1.6), { createdBy: B });
    const second = await t.service.create(withReuse('Ketiga', viaGroup.id), { createdBy: B });
    for (const story of [later, second]) {
      await t.service.render(story.id);
      await t.service.reconcile(story.id);
      const shot = (await t.service.get(story.id))!.shots.find(s => s.id === '01-reuse')!;
      expect(shot.status, story.id).toBe('done');
      expect(readFileSync(clipOf(t, story.id)).equals(Buffer.alloc(4096, 9))).toBe(true);
    }
    // the story's own job (group = its id) is always usable
    const third = await t.service.create(own('Keempat'), { createdBy: B });
    const ownJob = await finishedClip(t, { group: third.id });
    const updated = await t.service.updateStoryboard(third.id, withReuse('Keempat', ownJob.id));
    expect(updated.rev).toBe(2);
  });

  it('a group job of ANOTHER user\'s story is refused, even though the job carries no createdBy', async () => {
    const t = setup();
    const alices = await t.service.create(own('Punya Alice'), { createdBy: A });
    const aliceJob = await finishedClip(t, { group: alices.id });
    const error = await t.service.create(withReuse('Punya B', aliceJob.id), { createdBy: B }).catch(e => e);
    expect((error as StoryError).code).toBe('INVALID');
  });

  it('legacy: unattributed clips (no createdBy, no group) are reusable by ownerless stories and by the legacy owner only', async () => {
    const t = setup('u_joseph');
    const old = await finishedClip(t);
    expect((await t.service.create(withReuse('Tanpa pemilik', old.id))).id).toMatch(/^story_/);
    expect((await t.service.create(withReuse('Joseph', old.id), { createdBy: 'u_joseph' })).id).toMatch(/^story_/);
    const error = await t.service.create(withReuse('Bob', old.id), { createdBy: B }).catch(e => e);
    expect((error as StoryError).code).toBe('INVALID');
    // without a legacy owner configured nothing owned reaches an unattributed clip
    const t2 = setup();
    const old2 = await finishedClip(t2);
    await expect(t2.service.create(withReuse('Joseph', old2.id), { createdBy: 'u_joseph' })).rejects.toBeInstanceOf(StoryError);
  });

  it('saving an UNCHANGED reuse never breaks an existing board (only a newly added jobId is checked)', async () => {
    const t = setup();
    const old = await finishedClip(t);                       // unattributed; Bob is not the legacy owner
    const mine = await t.service.create(own('Punya B'), { createdBy: B });
    plant(t, mine.id, withReuse('Punya B', old.id));
    const rec = JSON.parse(readFileSync(join(t.service.storyDir(mine.id), 'story.json'), 'utf8'));
    rec.shots.push({ id: '01-reuse', status: 'pending', attempts: 0 });
    writeFileSync(join(t.service.storyDir(mine.id), 'story.json'), JSON.stringify(rec, null, 1));
    const renamed = await t.service.updateStoryboard(mine.id, withReuse('Judul baru', old.id));
    expect(renamed.title).toBe('Judul baru');
  });

  it('a reuse of a job that does not exist is still accepted at save (as before) and fails at render with the same message', async () => {
    const t = setup();
    const story = await t.service.create(withReuse('Hantu', 'job_0123456789abcdef'), { createdBy: B });
    await t.service.render(story.id);
    await t.service.reconcile(story.id);
    const shot = (await t.service.get(story.id))!.shots.find(s => s.id === '01-reuse')!;
    expect(shot.status).toBe('failed');
    expect(shot.error).toBe('Klip job_0123456789abcdef tidak tersedia untuk dipakai ulang');
  });

  it('clip hashes do not change: reuse hashes its spec exactly as before, and a legit reuse stores that same hash', async () => {
    const t = setup();
    const spec = { jobId: 'job_0123456789abcdef', start: 1.6 };
    const sha16 = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
    const board = withReuse('Hash', spec.jobId, 1.6);
    expect(hashFor(board, board.shots[1]!)).toBe(sha16);
    expect(sha16).toBe('56aebd13a0460d0a'); // pinned from the code before the hotfix
    const mine = await finishedClip(t, { createdBy: B });
    const story = await t.service.create(withReuse('Hash', mine.id, 1.6), { createdBy: B });
    await t.service.render(story.id);
    await t.service.reconcile(story.id);
    const shot = (await t.service.get(story.id))!.shots.find(s => s.id === '01-reuse')!;
    expect(shot.promptHash).toBe(createHash('sha256').update(JSON.stringify({ jobId: mine.id, start: 1.6 })).digest('hex').slice(0, 16));
  });
});

describe('HOTFIX T3-reuse over HTTP', () => {
  it('a second admin gets 400 with a plain Indonesian message for POST/PUT that reuse the first user\'s clip; own clip still works', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-reuse-http-'));
    const flow = new FlowStore(join(dataDir, 'flow'));
    const t = { dataDir, flow } as T;
    const alices = await finishedClip(t, { createdBy: 'u_alice' });
    const server = await buildApp({ dataDir, env: { OPENCREATOR_ADMIN_EMAIL: 'a@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' }, logger: false, stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 } });
    const bob = await new UserAuthStore(dataDir).createUser({ email: 'b@x.io', password: 'bob-pass-123', isAdmin: true });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'b@x.io', password: 'bob-pass-123' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const post = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: withReuse('Curian', alices.id) } });
    expect(post.statusCode).toBe(400);
    expect(JSON.stringify(post.json())).toMatch(/dipakai ulang/);
    expect(JSON.stringify(post.json())).toMatch(/milik Anda/);
    const created = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: own('Punya Bob') } });
    expect(created.statusCode).toBe(201);
    const id = created.json().story.id as string;
    const put = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: withReuse('Curian', alices.id) } });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(put.json())).toMatch(/dipakai ulang/);
    const bobsClip = await finishedClip(t, { createdBy: bob.id });
    const ok = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: withReuse('Sah', bobsClip.id) } });
    expect(ok.statusCode).toBe(200);
    await server.close();
  });
});

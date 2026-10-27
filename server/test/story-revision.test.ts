import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryError } from '../src/stories/service.js';
import { MAX_SNAPSHOTS } from '../src/stories/snapshots.js';
import { compileBoardShot, type Storyboard } from '../src/stories/storyboard.js';
import { bibleBoard, finishQueued, renderedStory, serviceSetup } from './bible-board.js';

const legacyBoard = (): Storyboard => ({
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
});

const boardFile = (dataDir: string, id: string) => join(dataDir, 'stories', id, 'storyboard.json');
const recordFile = (dataDir: string, id: string) => join(dataDir, 'stories', id, 'story.json');

describe('story revisions', () => {
  it('starts at 1, +1 on every storyboard change, unchanged saves keep it', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    expect(story.rev).toBe(1);
    const board = await t.service.readStoryboard(story.id);
    const edited = await t.service.updateStoryboard(story.id, { ...board, title: 'Kucing Pulang' });
    expect(edited.rev).toBe(2);
    const same = await t.service.updateStoryboard(story.id, await t.service.readStoryboard(story.id));
    expect(same.rev).toBe(2);
    const looked = await t.service.setLook(story.id, { style: 'storybook' });
    expect(looked.rev).toBe(3);
  });

  it('a stale rev is refused with STALE and the board stays as it was', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    const board = await t.service.readStoryboard(story.id);
    await t.service.updateStoryboard(story.id, { ...board, title: 'Satu' }, { rev: 1 });
    const before = readFileSync(boardFile(t.dataDir, story.id), 'utf8');
    const error = await t.service.updateStoryboard(story.id, { ...board, title: 'Dua' }, { rev: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).code).toBe('STALE');
    expect(readFileSync(boardFile(t.dataDir, story.id), 'utf8')).toBe(before);
    expect((await t.service.get(story.id))!.rev).toBe(2);
  });

  it('an old record without rev reads as rev 1', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    const raw = JSON.parse(readFileSync(recordFile(t.dataDir, story.id), 'utf8'));
    delete raw.rev;
    writeFileSync(recordFile(t.dataDir, story.id), JSON.stringify(raw));
    expect((await t.service.get(story.id))!.rev).toBe(1);
    const board = await t.service.readStoryboard(story.id);
    expect((await t.service.updateStoryboard(story.id, { ...board, title: 'Baru' }, { rev: 1 })).rev).toBe(2);
  });
});

describe('undo snapshots', () => {
  it('restore after an edit that re-queued a paid clip brings the take back (done, same jobId/promptHash, byte-identical board)', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, legacyBoard());
    expect(done.status).toBe('done');
    const boardBytes = readFileSync(boardFile(t.dataDir, done.id), 'utf8');
    const shotsBefore = JSON.stringify(done.shots);

    const taken = await t.service.snapshots.take(done.id, 'ubah shot 2');
    expect(taken.rev).toBe(done.rev);
    const board = await t.service.readStoryboard(done.id);
    const edited = await t.service.updateStoryboard(done.id, {
      ...board, shots: board.shots.map(s => (s.id === '01-a' ? { ...s, prompt: 'Close-up of a kitten asleep on a porch.' } : s))
    }, { rev: taken.rev });
    expect(edited.shots.find(s => s.id === '01-a')!.status).toBe('pending');
    await t.service.snapshots.commit(taken.undoId, edited.rev);

    expect((await t.service.restoreSnapshot(done.id, taken.undoId, edited.rev)).result).toBe('ok');
    const restored = (await t.service.get(done.id))!;
    expect(readFileSync(boardFile(t.dataDir, done.id), 'utf8')).toBe(boardBytes);
    expect(JSON.stringify(restored.shots)).toBe(shotsBefore);
    expect(restored.shots.find(s => s.id === '01-a')).toMatchObject({ status: 'done', jobId: done.shots[1]!.jobId, promptHash: done.shots[1]!.promptHash });
    // A restore is itself a change: open tabs go stale.
    expect(restored.rev).toBe(edited.rev + 1);
    expect(restored.status).toBe('done');
  });

  it('restore re-links the restored clip file when a newer take replaced it', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, legacyBoard());
    const shotFile = t.service.shotPath(done.id, '01-a');
    const original = readFileSync(shotFile);
    const taken = await t.service.snapshots.take(done.id, 'ubah shot 2');
    const board = await t.service.readStoryboard(done.id);
    const edited = await t.service.updateStoryboard(done.id, {
      ...board, shots: board.shots.map(s => (s.id === '01-a' ? { ...s, prompt: 'Close-up of a kitten asleep on a porch.' } : s))
    });
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    await t.service.render(done.id, { force: true });
    await finishQueued(t, 'video');
    await t.service.reconcile(done.id);
    expect(readFileSync(shotFile).equals(original)).toBe(false);
    expect((await t.service.restoreSnapshot(done.id, taken.undoId, edited.rev)).result).toBe('ok');
    expect(readFileSync(shotFile).equals(original)).toBe(true);
  });

  it('refuses with stale when the board moved on after that change, and missing for an unknown id', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    const taken = await t.service.snapshots.take(story.id, 'judul');
    const board = await t.service.readStoryboard(story.id);
    const edited = await t.service.updateStoryboard(story.id, { ...board, title: 'Satu' });
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    const later = await t.service.updateStoryboard(story.id, { ...board, title: 'Dua' });
    const before = readFileSync(boardFile(t.dataDir, story.id), 'utf8');
    expect((await t.service.restoreSnapshot(story.id, taken.undoId, later.rev)).result).toBe('stale');
    // The caller's view is checked too: a tab that read the old rev cannot undo.
    expect((await t.service.restoreSnapshot(story.id, taken.undoId, edited.rev)).result).toBe('stale');
    expect(readFileSync(boardFile(t.dataDir, story.id), 'utf8')).toBe(before);
    expect((await t.service.get(story.id))!.rev).toBe(later.rev);
    expect((await t.service.restoreSnapshot(story.id, 'u_0000000000000000_0000000000000_0000', later.rev)).result).toBe('missing');
    expect((await t.service.restoreSnapshot(story.id, '../../etc/passwd', later.rev)).result).toBe('missing');
    // An uncommitted snapshot (the change failed) cannot be restored either.
    const orphan = await t.service.snapshots.take(story.id, 'gagal');
    expect((await t.service.restoreSnapshot(story.id, orphan.undoId, later.rev)).result).toBe('missing');
  });

  it('keeps a ring of the newest 50 snapshots per story', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    const ids: string[] = [];
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) ids.push((await t.service.snapshots.take(story.id, `langkah ${i}`)).undoId);
    expect(MAX_SNAPSHOTS).toBe(50);
    const files = readdirSync(join(t.dataDir, 'stories', story.id, 'snapshots'));
    expect(files).toHaveLength(50);
    expect(files.sort()).toEqual(ids.slice(5).map(id => `${id}.json`).sort());
  });

  it('undo after a paid render keeps the paid take: re-applying the same edit reinstates it (no new job)', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, bibleBoard());
    const j1 = done.shots[1]!.jobId!;
    const edit = (b: Storyboard): Storyboard => ({
      ...b, shots: b.shots.map(s => (s.id === '02-kapas' ? { ...s, intent: { ...s.intent!, subject: 'KAPAS', action: 'peeks out of the woven basket' } } : s))
    });
    const taken = await t.service.snapshots.take(done.id, 'ubah intent');
    const edited = await t.service.updateStoryboard(done.id, edit(await t.service.readStoryboard(done.id)), { rev: taken.rev });
    expect(edited.rev).toBe(taken.rev + 1);
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    await t.service.render(done.id, { force: true });
    await finishQueued(t, 'video');
    const rendered = (await t.service.reconcile(done.id))!;
    const paid = rendered.shots[1]!;
    expect(paid.status).toBe('done');
    expect(paid.jobId).not.toBe(j1);
    const shotFile = t.service.shotPath(done.id, '02-kapas');
    const paidBytes = readFileSync(shotFile);

    expect((await t.service.restoreSnapshot(done.id, taken.undoId, rendered.rev)).result).toBe('ok');
    const restored = (await t.service.get(done.id))!;
    expect(restored.shots[1]).toMatchObject({ status: 'done', jobId: j1 });
    expect(readFileSync(shotFile).equals(paidBytes)).toBe(false);

    const jobs = (await t.flow.listJobs()).length;
    const again = await t.service.updateStoryboard(done.id, edit(await t.service.readStoryboard(done.id)), { rev: restored.rev });
    expect(again.shots[1]).toMatchObject({ status: 'done', jobId: paid.jobId, promptHash: paid.promptHash });
    expect(readFileSync(shotFile).equals(paidBytes)).toBe(true);
    await t.service.render(done.id, { force: true });
    expect((await t.flow.listJobs()).length).toBe(jobs);
  });

  it('restore never says done while the cut is stale (a newer cut was assembled after the snapshot)', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, legacyBoard());
    const taken = await t.service.snapshots.take(done.id, 'ubah shot 2');
    await new Promise(r => setTimeout(r, 5));
    const board = await t.service.readStoryboard(done.id);
    const edited = await t.service.updateStoryboard(done.id, {
      ...board, shots: board.shots.map(s => (s.id === '01-a' ? { ...s, prompt: 'Close-up of a kitten asleep on a porch.' } : s))
    });
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    await t.service.render(done.id, { force: true });
    await finishQueued(t, 'video');
    const v2 = (await t.service.reconcile(done.id))!;
    expect(v2.status).toBe('done');
    expect(v2.video!.finishedAtMs).toBeGreaterThan(done.video!.finishedAtMs);
    expect((await t.service.restoreSnapshot(done.id, taken.undoId, v2.rev)).result).toBe('ok');
    const restored = (await t.service.get(done.id))!;
    expect(restored.videoStale).toBe(true);
    expect(restored.status).toBe('review');
  });

  it('restore whose old clip file is gone: ok, the shot must be rendered again and is listed for attention', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, legacyBoard());
    const j1 = done.shots[1]!.jobId!;
    const taken = await t.service.snapshots.take(done.id, 'ubah shot 2');
    const board = await t.service.readStoryboard(done.id);
    const edited = await t.service.updateStoryboard(done.id, {
      ...board, shots: board.shots.map(s => (s.id === '01-a' ? { ...s, prompt: 'Close-up of a kitten asleep on a porch.' } : s))
    });
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    await t.service.render(done.id, { force: true });
    await finishQueued(t, 'video');
    const v2 = (await t.service.reconcile(done.id))!;
    rmSync((await t.flow.getJob(j1))!.resultPath!);
    const outcome = await t.service.restoreSnapshot(done.id, taken.undoId, v2.rev);
    expect(outcome.result).toBe('ok');
    expect(outcome.attention).toEqual([{ id: '01-a', take: 'clip' }]);
    const restored = (await t.service.get(done.id))!;
    // The record never claims a take whose media is gone, and the newer file is not passed off as it.
    expect(restored.shots[1]).toMatchObject({ status: 'pending' });
    expect(restored.shots[1]!.jobId).toBeUndefined();
    expect(existsSync(t.service.shotPath(done.id, '01-a'))).toBe(false);
    expect(restored.status).toBe('draft');
    expect(restored.shots[0]).toEqual(done.shots[0]);
  });

  it('take refuses a busy story (render running) with BUSY and writes no snapshot', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    await t.service.render(story.id, { force: true });
    expect((await t.service.get(story.id))!.status).toBe('rendering');
    const error = await t.service.snapshots.take(story.id, 'saat render').catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).code).toBe('BUSY');
    expect(await t.service.snapshots.list(story.id)).toEqual([]);
  });

  it('redrawFrame with a new prompt while the cast sheet is not ready leaves board and rev untouched', async () => {
    const t = serviceSetup();
    const story = await t.service.create({
      title: 'Konsisten', mode: 'konsisten', audio: 'Audio: voice-over: "{line}"', characters: { MIMI: 'a grey kitten' },
      shots: [{ id: '01-a', prompt: 'Medium shot of MIMI on a porch.', narration: 'Mimi menunggu.' }]
    });
    const before = readFileSync(boardFile(t.dataDir, story.id), 'utf8');
    const error = await t.service.redrawFrame(story.id, '01-a', 'Close-up of MIMI asleep on a porch.').catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).message).toBe('Lembar karakter belum siap');
    expect(readFileSync(boardFile(t.dataDir, story.id), 'utf8')).toBe(before);
    expect((await t.service.get(story.id))!.rev).toBe(1);
  });
});

async function appSetup() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-rev-app-'));
  const email = `admin-${Math.random().toString(36).slice(2, 8)}@x.io`;
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      generateText: async () => '{}'
    }
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { server, cookie, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
}

describe('story routes: rev + compile-shot', () => {
  it('GET returns rev; PUT with an old rev is 409 STALE and the board is unchanged; no rev = no check', async () => {
    const { server, cookie, dataDir } = await appSetup();
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: legacyBoard() } })).json().story.id;
    const got = await server.inject({ url: `/api/stories/${id}`, headers: { cookie } });
    expect(got.json().story.rev).toBe(1);
    const ok = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: { ...legacyBoard(), title: 'Satu' }, rev: 1 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().story.rev).toBe(2);
    const before = readFileSync(boardFile(dataDir, id), 'utf8');
    const stale = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: { ...legacyBoard(), title: 'Dua' }, rev: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'STALE', message: 'Proyek baru diubah di tempat lain — muat ulang.' } });
    expect(readFileSync(boardFile(dataDir, id), 'utf8')).toBe(before);
    const bad = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: legacyBoard(), rev: 'x' } });
    expect(bad.statusCode).toBe(400);
    const legacyClient = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: { ...legacyBoard(), title: 'Tiga' } } });
    expect(legacyClient.statusCode).toBe(200);
    expect(legacyClient.json().story.rev).toBe(3);
  });

  it('compile-shot returns lint-clean prompts for a drafted shot and issues for an empty intent, without saving', async () => {
    const { server, cookie, dataDir } = await appSetup();
    const board = bibleBoard();
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    const before = readFileSync(boardFile(dataDir, id), 'utf8');
    const shot = { ...board.shots[1]!, intent: { ...board.shots[1]!.intent!, emotion: 'lega' } };
    const res = await server.inject({ method: 'POST', url: `/api/stories/${id}/compile-shot`, headers: { cookie }, payload: { shot } });
    expect(res.statusCode).toBe(200);
    const compiled = compileBoardShot({ ...board, shots: [board.shots[0]!, shot] }, shot);
    expect(res.json()).toMatchObject({ imagePrompt: compiled.imagePrompt, videoPrompt: compiled.videoPrompt, issues: [] });
    expect(res.json().videoPrompt).toContain('Laras');

    const empty = await server.inject({
      method: 'POST', url: `/api/stories/${id}/compile-shot`, headers: { cookie },
      payload: { shot: { id: '09-baru', prompt: '', narration: 'Satu dua.', intent: { subject: '', action: '', startState: '', endState: '' } } }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().issues.join(' ')).toMatch(/subject is empty/);
    expect(empty.json().imagePrompt).toBe('');
    expect(readFileSync(boardFile(dataDir, id), 'utf8')).toBe(before);

    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/compile-shot`, headers: { cookie }, payload: {} })).statusCode).toBe(400);
    for (const bad of [{ shot: 'x' }, { shot: [shot] }, { shot: { ...shot, intent: 'lifts a basket' } }, { shot: { ...shot, intent: [] } }, { shot: { ...shot, intent: null } }]) {
      const res400 = await server.inject({ method: 'POST', url: `/api/stories/${id}/compile-shot`, headers: { cookie }, payload: bad });
      expect(res400.statusCode).toBe(400);
      expect(res400.json().error.code).toBe('INVALID');
    }
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/compile-shot`, payload: { shot } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/stories/story_0000000000000000/compile-shot', headers: { cookie }, payload: { shot } })).statusCode).toBe(404);
  });
});

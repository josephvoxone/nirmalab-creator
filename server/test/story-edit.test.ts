import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { musicExt } from '../src/stories/music.js';
import { hashFor, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { finishQueued, serviceSetup } from './bible-board.js';

const board = (): Storyboard => ({
  title: 'Dua Pasang Jejak',
  characters: { RAKA: 'a boy in a red hoodie' },
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '01-a', prompt: 'Medium shot, RAKA prays.', narration: 'Setiap malam Raka berdoa.' },
    { id: '02-b', prompt: 'Wide shot, RAKA on the beach.', narration: 'Dia tidak pernah pergi.' }
  ]
});

const mp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(4000, 7)]);
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(4000, 1)]);
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.alloc(4000, 1)]);

describe('timeline edit: validation', () => {
  it('accepts trims, clip volume, music and subtitles', () => {
    const b = board();
    b.shots[1]!.trim = { in: 0.5, out: 4 };
    b.edit = { clipVolume: 0.8, subtitles: true, subtitleStyle: 'tulisan-tangan', music: { file: 'music.mp3', name: 'Hymn.mp3', seconds: 95.2, volume: 0.35, at: 1, from: 0 } };
    expect(validateStoryboard(b)).toEqual([]);
  });

  it('refuses a trim that runs backwards or is negative, and out-of-range edit values', () => {
    const errors = (patch: (b: Storyboard) => void) => { const b = board(); patch(b); return validateStoryboard(b).join('; '); };
    expect(errors(b => { b.shots[0]!.trim = { in: 3, out: 2 }; })).toMatch(/01-a: trim/);
    expect(errors(b => { b.shots[0]!.trim = { in: -1 }; })).toMatch(/01-a: trim/);
    expect(errors(b => { b.edit = { clipVolume: 5 }; })).toMatch(/edit\.clipVolume/);
    expect(errors(b => { b.edit = { music: { file: '../../etc/passwd', name: 'x', seconds: 3, volume: 0.3, at: 0 } }; })).toMatch(/edit\.music\.file/);
    expect(errors(b => { b.edit = { music: { file: 'music.mp3', name: 'x', seconds: 3, volume: 9, at: 0 } }; })).toMatch(/edit\.music\.volume/);
    expect(errors(b => { b.edit = { subtitles: 'yes' } as unknown as Storyboard['edit']; })).toMatch(/edit\.subtitles/);
    expect(errors(b => { b.edit = { subtitles: true, subtitleStyle: 'comic-sans' } as unknown as Storyboard['edit']; })).toMatch(/edit\.subtitleStyle/);
  });

  it('edits never change a clip prompt: no clip is rendered again for a trim, music or subtitles', () => {
    const b = board();
    const edited = { ...b, edit: { subtitles: true, clipVolume: 0.5 }, shots: b.shots.map(s => ({ ...s, trim: { in: 1 } })) };
    for (let i = 0; i < b.shots.length; i++) expect(hashFor(edited, edited.shots[i]!)).toBe(hashFor(b, b.shots[i]!));
  });
});

describe('timeline edit: the video must be assembled again', () => {
  async function assembled() {
    const t = serviceSetup();
    const story = await t.service.create(board());
    await t.service.render(story.id, { force: true });
    await finishQueued(t, 'video');
    await t.service.reconcile(story.id);
    await t.service.assemble(story.id);
    const done = (await t.service.get(story.id))!;
    expect(done.status).toBe('done');
    return { t, id: story.id, rev: done.rev };
  }

  it('a trim, music or subtitles change marks the video stale and keeps every clip', async () => {
    const { t, id } = await assembled();
    for (const patch of [
      (b: Storyboard) => { b.shots[1]!.trim = { in: 1 }; },
      (b: Storyboard) => { b.edit = { ...b.edit, subtitles: true }; },
      (b: Storyboard) => { b.edit = { ...b.edit, music: { file: 'music.mp3', name: 'a.mp3', seconds: 30, volume: 0.3, at: 0 } }; }
    ]) {
      const b = await t.service.readStoryboard(id);
      patch(b);
      const r = await t.service.updateStoryboard(id, b);
      expect(r.videoStale).toBe(true);
      expect(r.status).toBe('review');
      expect(r.shots.every(s => s.status === 'done')).toBe(true);
      await t.service.assemble(id);
    }
  });

  it('with subtitles on, a narration edit makes the video stale too', async () => {
    const { t, id } = await assembled();
    const b = await t.service.readStoryboard(id);
    b.edit = { subtitles: true };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    const again = await t.service.readStoryboard(id);
    expect((await t.service.get(id))!.videoStale).toBeFalsy();
    again.shots[0]!.narration = 'Setiap malam, Nenek mengajari Raka berdoa.';
    // narration is spoken in a legacy board: the clip is redone — the point here is only "stale".
    expect((await t.service.updateStoryboard(id, again)).videoStale).toBe(true);
  });

  it('the assembly plan carries the edit: trims, music by absolute path, clip volume and narration for subtitles', async () => {
    const { t, id } = await assembled();
    const b = await t.service.readStoryboard(id);
    b.shots[0]!.trim = { in: 0.5, out: 4 };
    b.edit = { clipVolume: 0.7, subtitles: true, music: { file: 'music.mp3', name: 'Hymn.mp3', seconds: 60, volume: 0.3, at: 1.5, from: 2 } };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    const plan = JSON.parse(readFileSync(join(t.service.storyDir(id), 'assemble.json'), 'utf8'));
    expect(plan.shots[0].trim).toEqual({ in: 0.5, out: 4 });
    expect(plan.shots.map((s: { narration?: string }) => s.narration)).toEqual(['Setiap malam Raka berdoa.', 'Dia tidak pernah pergi.']);
    expect(plan.edit).toEqual({ clipVolume: 0.7, subtitles: true, music: { path: join(t.service.storyDir(id), 'music.mp3'), volume: 0.3, at: 1.5, from: 2 } });
  });

  it('handwritten subtitles: the style reaches the assembly plan, and switching it marks the video stale', async () => {
    const { t, id } = await assembled();
    const b = await t.service.readStoryboard(id);
    b.edit = { subtitles: true };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    expect((await t.service.get(id))!.videoStale).toBeFalsy();
    b.edit = { subtitles: true, subtitleStyle: 'tulisan-tangan' };
    const after = await t.service.updateStoryboard(id, b);
    expect(after.videoStale).toBe(true);
    expect(after.shots.every(s => s.status === 'done')).toBe(true);
    await t.service.assemble(id);
    const plan = JSON.parse(readFileSync(join(t.service.storyDir(id), 'assemble.json'), 'utf8'));
    expect(plan.edit).toEqual({ subtitles: true, subtitleStyle: 'tulisan-tangan' });
  });
});

describe('music upload', () => {
  it('knows audio by its bytes', () => {
    expect(musicExt(mp3())).toBe('mp3');
    expect(musicExt(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90]), Buffer.alloc(100)]))).toBe('mp3');
    expect(musicExt(m4a())).toBe('m4a');
    expect(musicExt(wav())).toBe('wav');
    expect(musicExt(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)]))).toBe('ogg');
    expect(musicExt(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]))).toBeUndefined();
  });

  async function app(hasAudio = true) {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-music-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 95.24, hasAudio }), assemble: async () => undefined },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 }
    });
    const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board() } })).json().story.id as string;
    return { server, cookie, id, dataDir };
  }

  it('POST stores one music file per project (a new one replaces the old) and GET plays it with ranges', async () => {
    const { server, cookie, id, dataDir } = await app();
    const up = await server.inject({ method: 'POST', url: `/api/stories/${id}/music`, headers: { cookie, 'content-type': 'audio/mpeg', 'x-file-name': encodeURIComponent('Kidung Malam.mp3') }, payload: mp3() });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toEqual({ file: 'music.mp3', name: 'Kidung Malam.mp3', seconds: 95.24 });
    const second = await server.inject({ method: 'POST', url: `/api/stories/${id}/music`, headers: { cookie, 'content-type': 'audio/mp4' }, payload: m4a() });
    expect(second.json()).toMatchObject({ file: 'music.m4a', name: 'Musik' });
    expect(readdirSync(join(dataDir, 'stories', id)).filter(f => f.startsWith('music.'))).toEqual(['music.m4a']);

    const got = await server.inject({ url: `/api/stories/${id}/music`, headers: { cookie, range: 'bytes=0-9' } });
    expect(got.statusCode).toBe(206);
    expect(got.headers['content-type']).toBe('audio/mp4');
    expect(got.rawPayload.equals(m4a().subarray(0, 10))).toBe(true);
  });

  it('refuses what is not audio (by its bytes), a file with no audio stream, and anyone but an admin', async () => {
    const { server, cookie, id, dataDir } = await app();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000)]);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/music`, headers: { cookie, 'content-type': 'audio/mpeg' }, payload: png })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/music`, headers: { 'content-type': 'audio/mpeg' }, payload: mp3() })).statusCode).toBe(401);
    expect(existsSync(join(dataDir, 'stories', id, 'music.mp3'))).toBe(false);
    const silent = await app(false);
    const r = await silent.server.inject({ method: 'POST', url: `/api/stories/${silent.id}/music`, headers: { cookie: silent.cookie, 'content-type': 'audio/mpeg' }, payload: mp3() });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/suara/);
    expect(existsSync(join(silent.dataDir, 'stories', silent.id, 'music.mp3'))).toBe(false);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';

const board = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
};

async function setup(draftReply?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-sr-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      generateText: async () => draftReply ?? JSON.stringify(board)
    }
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { server, cookie, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
}

describe('story routes', () => {
  it('need a session', async () => {
    const { server } = await setup();
    expect((await server.inject('/api/stories')).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/stories', payload: { storyboard: board } })).statusCode).toBe(401);
  });

  it('create validates and returns 400 with the rule violations', async () => {
    const { server, cookie } = await setup();
    const bad = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: { ...board, shots: [] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/no shots/);
    const ok = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().story.status).toBe('draft');
  });

  it('full flow over HTTP: render → bridge finishes → GET advances → video downloadable', async () => {
    const { server, cookie, dataDir, flow } = await setup();
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    const rendered = await server.inject({ method: 'POST', url: `/api/stories/${id}/render`, headers: { cookie }, payload: {} });
    expect(rendered.statusCode).toBe(200);
    expect((await server.inject({ url: `/api/stories/${id}/video`, headers: { cookie } })).statusCode).toBe(404);
    const clips = join(dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    for (const job of await flow.listJobs()) {
      writeFileSync(join(clips, `${job.id}.mp4`), Buffer.alloc(9000, 1));
      await flow.completeJob(job.id, { filePath: join(clips, `${job.id}.mp4`), bytes: 9000 });
    }
    const detail = await server.inject({ url: `/api/stories/${id}`, headers: { cookie } });
    expect(detail.json().story.status).toBe('done');
    expect(detail.json().storyboard.title).toBe('Kucing Hilang');
    const video = await server.inject({ url: `/api/stories/${id}/video`, headers: { cookie } });
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toBe('video/mp4');
    expect(video.rawPayload.length).toBe(5000);
    const shot = await server.inject({ url: `/api/stories/${id}/shots/01-a/video`, headers: { cookie } });
    expect(shot.statusCode).toBe(200);
    expect((await server.inject({ url: `/api/stories/${id}/shots/..%2Fx/video`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('the real bridge HTTP path feeds stories: claim → upload → QC → assembled', async () => {
    const { server, cookie, dataDir } = await setup();
    mkdirSync(join(dataDir, 'flow'), { recursive: true });
    writeFileSync(join(dataDir, 'flow', 'bridge-token'), 'bridge-secret-token-1234567890');
    const h = { 'x-flow-bridge-token': 'bridge-secret-token-1234567890' };
    expect((await server.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie }, payload: { label: 'mac', email: 'm@x.io' } })).statusCode).toBe(200);
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    await server.inject({ method: 'POST', url: `/api/stories/${id}/render`, headers: { cookie }, payload: {} });
    expect((await server.inject({ url: '/api/flow/jobs', headers: { cookie } })).json().jobs).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const claim = await server.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: h, payload: { bridgeId: 'mac' } });
      expect(claim.statusCode).toBe(200);
      const done = await server.inject({ method: 'POST', url: `/api/flow/bridge/jobs/${claim.json().job.id}/complete`, headers: { ...h, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(9000, 1) });
      expect(done.statusCode).toBe(200);
    }
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().story.status).toBe('done');
  });

  it('render answers 409 with the budget message when credits are short', async () => {
    const { server, cookie, flow } = await setup();
    const acc = await flow.addAccount({ label: 'a', email: 'a@x.io' });
    await flow.heartbeat('mac', [{ id: acc.id, credits: 3 }]);
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    const res = await server.inject({ method: 'POST', url: `/api/stories/${id}/render`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/credits/);
  });

  it('draft turns a premise into a saved draft story', async () => {
    const reply = JSON.stringify({ title: 'Kucing', characters: { CAT: 'an orange kitten' }, shots: [
      { id: 'intro', silent: true, prompt: 'Extreme wide shot of a village.' },
      { id: 'a', prompt: 'Close-up, the camera pushes in slowly. CAT waits.', narration: 'Mimi menunggu.' },
      { id: 'b', prompt: 'Wide shot, CAT runs home.', narration: 'Mimi pulang.' }] });
    const { server, cookie } = await setup(reply);
    const res = await server.inject({ method: 'POST', url: '/api/stories/draft', headers: { cookie }, payload: { premise: 'kucing hilang', shots: 3 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().story.shots).toHaveLength(3);
    const list = await server.inject({ url: '/api/stories', headers: { cookie } });
    expect(list.json().stories).toHaveLength(1);
  });

  it('edit and delete', async () => {
    const { server, cookie } = await setup();
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    const put = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: { ...board, title: 'Baru' } } });
    expect(put.json().story.title).toBe('Baru');
    expect((await server.inject({ method: 'DELETE', url: `/api/stories/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('catalog lists templates and pickers for members', async () => {
    const { server, cookie } = await setup();
    expect((await server.inject('/api/stories/catalog')).statusCode).toBe(401);
    const res = await server.inject({ url: '/api/stories/catalog', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().catalog.templates.length).toBeGreaterThanOrEqual(10);
    expect(res.json().catalog.moves.length).toBeGreaterThanOrEqual(20);
  });

  it('draft accepts template, look, mode and aspect', async () => {
    const reply = JSON.stringify({ title: 'Kucing', characters: { MIMI: 'an orange kitten' }, shots: [
      { id: 'buka', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A valley.' },
      { id: 'teras', prompt: 'Medium shot, the camera stays still. MIMI waits on a porch.', narration: 'Mimi menunggu.' }] });
    const { server, cookie } = await setup(reply);
    const res = await server.inject({ method: 'POST', url: '/api/stories/draft', headers: { cookie },
      payload: { premise: 'Kucing menunggu pemiliknya', template: 'dongeng-anak', look: { palette: 'noir' }, mode: 'konsisten', aspect: '9:16', shots: 3 } });
    expect(res.statusCode).toBe(201);
    const got = await server.inject({ url: `/api/stories/${res.json().story.id}`, headers: { cookie } });
    expect(got.json().story.mode).toBe('konsisten');
    expect(got.json().storyboard.look).toMatchObject({ palette: 'noir', style: 'storybook' });
    expect(got.json().storyboard.style).toMatch(/black and white/);
  });

  it('konsisten over HTTP: prepare → sheets + keyframes served as PNG → redraw → look change → render', async () => {
    const konsisten = { ...board, mode: 'konsisten', characters: { MIMI: 'an orange kitten with a blue collar' },
      shots: [board.shots[0], { id: '01-a', prompt: 'Medium shot, the camera stays still. MIMI sits on a porch.', narration: 'Mimi menunggu.' }] };
    const { server, cookie, dataDir, flow } = await setup();
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: konsisten } })).json().story.id;
    const early = await server.inject({ method: 'POST', url: `/api/stories/${id}/render`, headers: { cookie }, payload: {} });
    expect(early.statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/prepare`, headers: { cookie }, payload: {} })).json().story.status).toBe('casting');
    const clips = join(dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const png = (w: number, h: number) => { const b = Buffer.alloc(30_000, 7); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    const finishAll = async (kind: string) => {
      for (const job of (await flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
        const file = join(clips, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
        writeFileSync(file, png(720, 1280));
        await flow.completeJob(job.id, { filePath: file, bytes: 30_000, result: { mediaId: `m-${job.id}`, caption: 'cap', flowCharacterId: kind === 'character' ? 'fc1' : undefined } });
      }
    };
    await finishAll('character');
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().story.status).toBe('framing');
    const sheet = await server.inject({ url: `/api/stories/${id}/cast/MIMI/image`, headers: { cookie } });
    expect(sheet.statusCode).toBe(200);
    expect(sheet.headers['content-type']).toBe('image/png');
    await finishAll('image');
    const review = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json();
    expect(review.story.status).toBe('review');
    const frame = await server.inject({ url: `/api/stories/${id}/shots/01-a/frame`, headers: { cookie } });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-type']).toBe('image/png');
    const jpgFile = join(dataDir, 'stories', id, 'frame-01-a.png');
    writeFileSync(jpgFile, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]));
    expect((await server.inject({ url: `/api/stories/${id}/shots/01-a/frame`, headers: { cookie } })).headers['content-type']).toBe('image/jpeg');
    expect((await server.inject({ url: `/api/stories/${id}/shots/../frame`, headers: { cookie } })).statusCode).toBe(404);

    const redraw = await server.inject({ method: 'POST', url: `/api/stories/${id}/shots/01-a/frame`, headers: { cookie }, payload: { prompt: 'Close-up, the camera pushes in slowly. MIMI smiles on a porch.' } });
    expect(redraw.statusCode).toBe(200);
    expect(redraw.json().story.status).toBe('framing');
    const bad = await server.inject({ method: 'POST', url: `/api/stories/${id}/shots/01-a/frame`, headers: { cookie }, payload: { prompt: 'Close-up, the camera pans left and tilts up. MIMI.' } });
    expect(bad.statusCode).toBe(409);
    await finishAll('image');
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().story.status).toBe('review');

    const look = await server.inject({ method: 'POST', url: `/api/stories/${id}/look`, headers: { cookie }, payload: { look: { style: 'pixar-3d', palette: 'riviera' } } });
    expect(look.statusCode).toBe(200);
    const after = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json();
    expect(after.storyboard.style).toMatch(/3D animated/);
    expect(after.story.status).toBe('draft');
    expect(after.story.shots.every((s: { frame?: { status: string } }) => !s.frame || s.frame.status === 'pending')).toBe(true);

    await server.inject({ method: 'POST', url: `/api/stories/${id}/prepare`, headers: { cookie }, payload: {} });
    await finishAll('character'); await server.inject({ url: `/api/stories/${id}`, headers: { cookie } });
    await finishAll('image'); await server.inject({ url: `/api/stories/${id}`, headers: { cookie } });
    const render = await server.inject({ method: 'POST', url: `/api/stories/${id}/render`, headers: { cookie }, payload: {} });
    expect(render.statusCode).toBe(200);
    const videos = (await flow.listJobs()).filter(j => j.kind === 'video');
    expect(videos.every(v => v.startFrame?.mediaId)).toBe(true);
  });
});

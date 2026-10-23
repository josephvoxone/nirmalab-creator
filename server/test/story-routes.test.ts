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
  return { server, cookie, dataDir, flow: new FlowStore(dataDir) };
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
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { CATALOG } from '../src/stories/looks.js';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-cov-'));
  const webDist = mkdtempSync(join(tmpdir(), 'nc-web-'));
  mkdirSync(join(webDist, 'templates'));
  writeFileSync(join(webDist, 'index.html'), '<div id="root"></div>');
  writeFileSync(join(webDist, 'templates', 'drama-hewan.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const server = await buildApp({
    dataDir, webDist,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => {}, generateText: async () => '{}' }
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { server, cookie, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
}

describe('template covers are generated through the app queue', () => {
  it('every template has a cover scene', () => {
    for (const t of CATALOG.templates) expect(t.cover.length, t.id).toBeGreaterThan(30);
  });

  it('serves the bundled cover until the app makes a new one', async () => {
    const { server, cookie } = await setup();
    expect((await server.inject('/api/stories/templates/drama-hewan/cover')).statusCode).toBe(401);
    const res = await server.inject({ url: '/api/stories/templates/drama-hewan/cover', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect((await server.inject({ url: '/api/stories/templates/nope/cover', headers: { cookie } })).statusCode).toBe(404);
  });

  it('admin queues a free 16:9 image job in the template look; when the bridge finishes, the new cover is served', async () => {
    const { server, cookie, dataDir, flow } = await setup();
    const queued = await server.inject({ method: 'POST', url: '/api/stories/templates/drama-hewan/cover', headers: { cookie }, payload: {} });
    expect(queued.statusCode).toBe(200);
    const job = (await flow.listJobs())[0]!;
    expect(job).toMatchObject({ kind: 'image', aspect: '16:9', technique: 'cover:drama-hewan' });
    expect(job.prompt).toMatch(/ginger cat/);
    expect(job.prompt).toMatch(/watercolor/);
    expect(job.prompt).toMatch(/no text/i);
    let cat = (await server.inject({ url: '/api/stories/catalog', headers: { cookie } })).json();
    expect(cat.covers['drama-hewan']).toMatchObject({ pending: true });
    expect((await server.inject({ method: 'POST', url: '/api/stories/templates/drama-hewan/cover', headers: { cookie }, payload: {} })).statusCode).toBe(409);

    const clips = join(dataDir, 'flow', 'clips'); mkdirSync(clips, { recursive: true });
    const file = join(clips, `${job.id}.png`);
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20_000, 9)]));
    await flow.completeJob(job.id, { filePath: file, bytes: 20_004 });
    const res = await server.inject({ url: '/api/stories/templates/drama-hewan/cover', headers: { cookie } });
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.byteLength).toBe(20_004);
    cat = (await server.inject({ url: '/api/stories/catalog', headers: { cookie } })).json();
    expect(cat.covers['drama-hewan']).toMatchObject({ pending: false });
    expect(cat.covers['drama-hewan'].updatedAtMs).toBeGreaterThan(0);
  });

  it('a failed cover job is reported and the old cover stays', async () => {
    const { server, cookie, flow } = await setup();
    await server.inject({ method: 'POST', url: '/api/stories/templates/drama-hewan/cover', headers: { cookie }, payload: {} });
    const job = (await flow.listJobs())[0]!;
    for (let i = 0; i < 3; i++) { await flow.claimJob(`b${i}`); await flow.failJob(job.id, 'Flow agent quote 2 credits is above the cap of 0'); }
    const cat = (await server.inject({ url: '/api/stories/catalog', headers: { cookie } })).json();
    expect(cat.covers['drama-hewan']).toMatchObject({ pending: false });
    expect(cat.covers['drama-hewan'].error).toMatch(/credits/);
    expect((await server.inject({ url: '/api/stories/templates/drama-hewan/cover', headers: { cookie } })).headers['content-type']).toBe('image/jpeg');
  });

  it('members cannot queue covers', async () => {
    const { server } = await setup();
    expect((await server.inject({ method: 'POST', url: '/api/stories/templates/drama-hewan/cover', payload: {} })).statusCode).toBe(401);
  });
});

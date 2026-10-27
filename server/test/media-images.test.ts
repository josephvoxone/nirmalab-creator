import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegRunner } from '../src/media/images.js';
import { CATALOG } from '../src/stories/looks.js';
import { makeMp4, makePng, probeBuffer, setupApp, FFMPEG } from './media-helpers.js';

function counted() {
  const real = ffmpegRunner(FFMPEG);
  const runner = Object.assign(async (args: string[]) => { runner.calls++; runner.args.push(args); await real(args); }, { calls: 0, args: [] as string[][] });
  return runner;
}

describe('image endpoints ?w=', () => {
  it('frame ?w=320 returns image/webp exactly 320 wide', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    makePng(join(t.storyDir, 'frame-01-a.png'), 640, 360);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=320`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const info = probeBuffer(res.rawPayload, t.dataDir);
    expect(info).toMatchObject({ codec: 'webp', width: 320, height: 180 });
  });

  it('never upscales: a 200-wide image asked at w=480 stays 200 wide', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    makePng(join(t.storyDir, 'frame-01-a.png'), 200, 100);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=480`, headers: { cookie: t.cookie } });
    expect(res.headers['content-type']).toBe('image/webp');
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ width: 200, height: 100 });
  });

  it('a cache hit returns the same bytes without running ffmpeg again; cached under cache/img', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    makePng(join(t.storyDir, 'frame-01-a.png'), 640, 360);
    const url = `/api/stories/${t.storyId}/shots/01-a/frame?w=160`;
    const first = await t.server.inject({ url, headers: { cookie: t.cookie } });
    const second = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(ffmpeg.calls).toBe(1);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    const cached = readdirSync(join(t.dataDir, 'cache', 'img'));
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatch(/^[a-f0-9]{40}\.webp$/);
    // Another width is another file.
    await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=320`, headers: { cookie: t.cookie } });
    expect(ffmpeg.calls).toBe(2);
  });

  it('a replaced original (redrawn frame) is resized again, not served stale', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    const file = join(t.storyDir, 'frame-01-a.png');
    makePng(file, 640, 360);
    const url = `/api/stories/${t.storyId}/shots/01-a/frame?w=160`;
    await t.server.inject({ url, headers: { cookie: t.cookie } });
    makePng(file, 400, 400, 'blue');
    const res = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(ffmpeg.calls).toBe(2);
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ width: 160, height: 160 });
  });

  it.each(['100', '0', '-320', 'abc', '', '320px', '1081'])('invalid w=%s → 400, no ffmpeg', async w => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    makePng(join(t.storyDir, 'frame-01-a.png'), 640, 360);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=${w}`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(400);
    expect(ffmpeg.calls).toBe(0);
  });

  it('without w: the original bytes, type from magic bytes, no ffmpeg', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    const file = makePng(join(t.storyDir, 'frame-01-a.png'), 640, 360);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(readFileSync(file))).toBe(true);
    expect(ffmpeg.calls).toBe(0);
  });

  it('cache-control: immutable with v=, five minutes without', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    makePng(join(t.storyDir, 'frame-01-a.png'), 640, 360);
    const base = `/api/stories/${t.storyId}/shots/01-a/frame`;
    const get = async (q: string) => (await t.server.inject({ url: `${base}${q}`, headers: { cookie: t.cookie } })).headers['cache-control'];
    expect(await get('?w=320&v=abc')).toBe('private, max-age=31536000, immutable');
    expect(await get('?v=abc')).toBe('private, max-age=31536000, immutable');
    expect(await get('?w=320')).toBe('private, max-age=300');
    expect(await get('')).toBe('private, max-age=300');
  });

  it('missing frame → 404 (with or without w); unauthenticated → 401', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    expect((await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=320`, headers: { cookie: t.cookie } })).statusCode).toBe(404);
    expect((await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/frame?w=320` })).statusCode).toBe(401);
  });

  it('cast image ?w=160 is webp 160 wide', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    makePng(join(t.storyDir, 'cast-MIMI.png'), 480, 480);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/cast/MIMI/image?w=160`, headers: { cookie: t.cookie } });
    expect(res.headers['content-type']).toBe('image/webp');
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ width: 160, height: 160 });
  });

  it('template cover ?w=320 is webp 320 wide; without w the original; bad w → 400', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    const template = CATALOG.templates[0]!.id;
    mkdirSync(join(t.dataDir, 'covers'), { recursive: true });
    const file = makePng(join(t.dataDir, 'covers', `${template}.png`), 1280, 720);
    renameSync(file, join(t.dataDir, 'covers', `${template}.img`));
    const url = `/api/stories/templates/${template}/cover`;
    const small = await t.server.inject({ url: `${url}?w=320&v=1`, headers: { cookie: t.cookie } });
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-type']).toBe('image/webp');
    expect(small.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(probeBuffer(small.rawPayload, t.dataDir)).toMatchObject({ width: 320, height: 180 });
    const original = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.rawPayload.equals(readFileSync(join(t.dataDir, 'covers', `${template}.img`)))).toBe(true);
    expect((await t.server.inject({ url: `${url}?w=7`, headers: { cookie: t.cookie } })).statusCode).toBe(400);
  });

  it('flow job file ?w=320 for image jobs; w on a video job → 400; video without w unchanged', async () => {
    const t = await setupApp({ media: { ffmpeg: counted() } });
    const clips = join(t.dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const still = await t.flow.createJob({ prompt: 'a still', kind: 'image', aspect: '16:9', durationSec: 6 });
    makePng(join(clips, `${still.id}.png`), 640, 360);
    await t.flow.completeJob(still.id, { filePath: join(clips, `${still.id}.png`), bytes: 1 });
    const res = await t.server.inject({ url: `/api/flow/jobs/${still.id}/file?w=320`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ width: 320 });
    expect((await t.server.inject({ url: `/api/flow/jobs/${still.id}/file?w=33`, headers: { cookie: t.cookie } })).statusCode).toBe(400);

    const clip = await t.flow.createJob({ prompt: 'a clip', kind: 'video', aspect: '16:9', durationSec: 6 });
    makeMp4(join(clips, `${clip.id}.mp4`), 1);
    await t.flow.completeJob(clip.id, { filePath: join(clips, `${clip.id}.mp4`), bytes: 1 });
    expect((await t.server.inject({ url: `/api/flow/jobs/${clip.id}/file?w=320`, headers: { cookie: t.cookie } })).statusCode).toBe(400);
    const video = await t.server.inject({ url: `/api/flow/jobs/${clip.id}/file`, headers: { cookie: t.cookie } });
    expect(video.headers['content-type']).toBe('video/mp4');
    expect(video.rawPayload.equals(readFileSync(join(clips, `${clip.id}.mp4`)))).toBe(true);
  });
});


describe('uploads ?w= (reference thumbnails)', () => {
  it('GET uploads/:file?w=64 answers a cached 64-wide webp; without ?w= the original bytes; odd widths are refused', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    const original = readFileSync(makePng(join(t.dataDir, 'ref.png'), 800, 1200));
    const up = await t.server.inject({ method: 'POST', url: `/api/stories/${t.storyId}/uploads`, headers: { cookie: t.cookie, 'content-type': 'image/png' }, payload: original });
    expect(up.statusCode).toBe(201);
    const url = up.json().url as string;
    const small = await t.server.inject({ url: `${url}?w=64`, headers: { cookie: t.cookie } });
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-type']).toBe('image/webp');
    expect(small.headers['x-content-type-options']).toBe('nosniff');
    expect(probeBuffer(small.rawPayload, t.dataDir)).toMatchObject({ codec: 'webp', width: 64, height: 96 });
    expect(small.rawPayload.length).toBeLessThan(original.length);
    // Cached like every other ?w= image.
    await t.server.inject({ url: `${url}?w=64`, headers: { cookie: t.cookie } });
    expect(ffmpeg.calls).toBe(1);
    expect((await t.server.inject({ url: `${url}?w=96`, headers: { cookie: t.cookie } })).headers['content-type']).toBe('image/webp');
    const raw = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(raw.headers['content-type']).toBe('image/png');
    expect(raw.rawPayload.equals(original)).toBe(true);
    expect((await t.server.inject({ url: `${url}?w=63`, headers: { cookie: t.cookie } })).statusCode).toBe(400);
    expect((await t.server.inject({ url: `${url}?w=64` })).statusCode).toBe(401);
  });
});

describe('posters', () => {
  const seek = (args: string[]) => Number(args[args.indexOf('-ss') + 1]);

  it('final video poster ?w=320: webp 320 wide of the frame at 1 s, cached', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    makeMp4(join(t.storyDir, 'final.mp4'), 3);
    const url = `/api/stories/${t.storyId}/video/poster?w=320&v=1`;
    const res = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ codec: 'webp', width: 320, height: 180 });
    expect(seek(ffmpeg.args[0]!)).toBe(1);
    const again = await t.server.inject({ url, headers: { cookie: t.cookie } });
    expect(ffmpeg.calls).toBe(1);
    expect(again.rawPayload.equals(res.rawPayload)).toBe(true);
  });

  it('shot clip poster: a clip shorter than 2 s uses its middle; no w = full width', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    makeMp4(join(t.storyDir, '01-a.mp4'), 1, 480, 270);
    const res = await t.server.inject({ url: `/api/stories/${t.storyId}/shots/01-a/poster`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(probeBuffer(res.rawPayload, t.dataDir)).toMatchObject({ width: 480, height: 270 });
    expect(seek(ffmpeg.args[0]!)).toBeCloseTo(0.5, 1);
  });

  it('404 without a video; bad w → 400; bad shot id → 404', async () => {
    const ffmpeg = counted();
    const t = await setupApp({ media: { ffmpeg } });
    const get = async (url: string) => (await t.server.inject({ url, headers: { cookie: t.cookie } })).statusCode;
    expect(await get(`/api/stories/${t.storyId}/video/poster?w=320`)).toBe(404);
    expect(await get(`/api/stories/${t.storyId}/shots/01-a/poster`)).toBe(404);
    expect(await get(`/api/stories/story_0000000000000000/video/poster`)).toBe(404);
    expect(await get(`/api/stories/${t.storyId}/shots/..%2Fx/poster`)).toBe(404);
    makeMp4(join(t.storyDir, 'final.mp4'), 3);
    expect(await get(`/api/stories/${t.storyId}/video/poster?w=999`)).toBe(400);
    expect(ffmpeg.calls).toBe(0);
    expect((await t.server.inject({ url: `/api/stories/${t.storyId}/video/poster` })).statusCode).toBe(401);
  });
});

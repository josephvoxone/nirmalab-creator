/** Shared fixtures for the media/storage tests: real ffmpeg on tiny generated files. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type AppOptions } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';

/** An ffmpeg with the libwebp encoder (prod: Debian ffmpeg; this Mac's Homebrew build has none). */
export const FFMPEG = [process.env.MEDIA_FFMPEG, 'ffmpeg', join(process.env.HOME ?? '', '.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg')]
  .filter((bin): bin is string => !!bin)
  .find(bin => {
    try { return execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('libwebp'); } catch { return false; }
  }) ?? 'ffmpeg';

export function makePng(file: string, width: number, height: number, color = 'red'): string {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', file]);
  return file;
}

export function makeMp4(file: string, seconds: number, width = 640, height = 360): string {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=10:duration=${seconds}`,
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', file]);
  return file;
}

/** Width/height/codec of an image or video, from ffprobe. */
export function probe(file: string): { width: number; height: number; codec: string } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  const s = (JSON.parse(out) as { streams: Array<{ width: number; height: number; codec_name: string }> }).streams[0]!;
  return { width: s.width, height: s.height, codec: s.codec_name };
}

export function probeBuffer(bytes: Buffer, dir: string): { width: number; height: number; codec: string } {
  const file = join(dir, `probe-${Math.random().toString(16).slice(2)}.bin`);
  writeFileSync(file, bytes);
  return probe(file);
}

export const board = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
};

export async function setupApp(extra: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-media-'));
  // Login is rate-limited per ip+email: a fresh admin per app keeps many tests under the limit.
  const email = `admin-${Math.random().toString(16).slice(2, 10)}@x.io`;
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async () => undefined,
      generateText: async () => JSON.stringify(board)
    },
    ...extra
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const created = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } });
  const storyId = created.json().story.id as string;
  return { server, cookie, dataDir, storyId, storyDir: join(dataDir, 'stories', storyId), flow: new FlowStore(join(dataDir, 'flow')) };
}

export { existsSync };

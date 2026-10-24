import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleStory, probeClip } from '../src/stories/media.js';

const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync(process.env.STORY_PYTHON ?? 'python3', ['-c', 'import PIL']).status === 0;

function clip(file: string, seconds: number, audio: boolean) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=720x1280:r=24:d=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), file);
  execFileSync('ffmpeg', args);
}

describe.skipIf(!hasTools)('story media (real ffmpeg + python)', () => {
  it('probeClip reads duration and whether there is an audio stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-probe-'));
    clip(join(dir, 'a.mp4'), 2, true);
    clip(join(dir, 'b.mp4'), 2, false);
    const a = await probeClip(join(dir, 'a.mp4'));
    expect(a.hasAudio).toBe(true);
    expect(a.durationSec).toBeGreaterThan(1.9);
    expect((await probeClip(join(dir, 'b.mp4'))).hasAudio).toBe(false);
    await expect(probeClip(join(dir, 'missing.mp4'))).rejects.toThrow();
  });

  it('assembleStory builds final.mp4 with title card and crossfades from assemble.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-asm-'));
    for (const id of ['00-intro', '01-a', '02-b']) clip(join(dir, `${id}.mp4`), 3, true);
    writeFileSync(join(dir, 'assemble.json'), JSON.stringify({
      title: 'Uji', slug: 'final', crossfade: 0.3, titleCard: { lines: ['UJI'], kicker: 'Tes' },
      shots: [{ id: '00-intro' }, { id: '01-a' }, { id: '02-b', reuse: { file: join(dir, '02-b.mp4'), start: 1 } }]
    }));
    await assembleStory(dir);
    expect(existsSync(join(dir, 'final.mp4'))).toBe(true);
    const probe = await probeClip(join(dir, 'final.mp4'));
    expect(probe.hasAudio).toBe(true);
    // 3 + 3 + 2 seconds minus two 0.3 s crossfades
    expect(probe.durationSec).toBeGreaterThan(7.2);
    expect(probe.durationSec).toBeLessThan(7.6);
  }, 120_000);

  it('assembleStory surfaces the assembler error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-asm-bad-'));
    writeFileSync(join(dir, 'assemble.json'), JSON.stringify({ title: 'x', slug: 'final', shots: [{ id: 'missing' }] }));
    await expect(assembleStory(dir)).rejects.toThrow(/missing shot/);
  });
});

describe('imageSize', () => {
  it('reads PNG, JPEG and WEBP headers and rejects other files', async () => {
    const { imageSize } = await import('../src/stories/media.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'nc-img-'));
    const png = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(768, 16); png.writeUInt32BE(1376, 20);
    writeFileSync(join(dir, 'a.png'), png);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x60, 0x03, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeFileSync(join(dir, 'a.jpg'), jpg);
    const webp = Buffer.alloc(40); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(767, 24, 3); webp.writeUIntLE(1375, 27, 3);
    writeFileSync(join(dir, 'a.webp'), webp);
    writeFileSync(join(dir, 'a.txt'), 'hello world, not an image at all.....');
    expect(await imageSize(join(dir, 'a.png'))).toEqual({ width: 768, height: 1376 });
    expect(await imageSize(join(dir, 'a.jpg'))).toEqual({ width: 768, height: 1376 });
    expect(await imageSize(join(dir, 'a.webp'))).toEqual({ width: 768, height: 1376 });
    await expect(imageSize(join(dir, 'a.txt'))).rejects.toThrow(/unknown/);
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleStory, probeClip } from '../src/stories/media.js';

const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('python3', ['-c', 'import PIL']).status === 0;

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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameTimes, sampleFrames } from '../src/audit/frames.js';

describe('frameTimes', () => {
  it('samples 10%, 50% and 90% of the clip', () => {
    expect(frameTimes(6)).toEqual([0.6, 3, 5.4]);
    expect(frameTimes(3)).toEqual([0.3, 1.5, 2.7]);
  });

  it('never asks for a timestamp past the end (or before the start)', () => {
    for (const t of frameTimes(0.2)) expect(t).toBeGreaterThanOrEqual(0);
    for (const t of frameTimes(0.2)) expect(t).toBeLessThanOrEqual(0.2);
    expect(frameTimes(0)).toEqual([0, 0, 0]);
  });
});

describe('sampleFrames', () => {
  it('writes three png files named per shot and passes -ss before -i', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-audit-frames-'));
    const clip = join(dir, '01-a.mp4');
    writeFileSync(clip, Buffer.alloc(2048, 1));
    const calls: string[][] = [];
    const files = await sampleFrames(clip, dir, '01-a', {
      duration: async () => 6,
      ffmpeg: async args => {
        calls.push(args);
        writeFileSync(args.at(-1)!, Buffer.alloc(512, 2));
      }
    });
    expect(files).toEqual([1, 2, 3].map(i => join(dir, `audit-01-a-${i}.png`)));
    expect(calls).toHaveLength(3);
    expect(calls.map(args => args[args.indexOf('-ss') + 1])).toEqual(['0.600', '3.000', '5.400']);
    expect(calls.every(args => args.indexOf('-ss') < args.indexOf('-i'))).toBe(true);
  });
});

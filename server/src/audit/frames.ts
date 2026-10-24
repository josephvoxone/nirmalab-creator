/**
 * Three frames per clip for the `cepat` clip audit (spec §9.3), at 10 %, 50 % and 90 % of the
 * clip: the audit sees the whole beat instead of one lucky still. `-ss` goes before `-i` so
 * ffmpeg seeks instead of decoding from the start.
 */
import { join } from 'node:path';
import { ffmpegRunner, videoDuration, type FfmpegRunner } from '../media/images.js';

export const SAMPLED_FRAMES = 3;
const FRACTIONS = [0.1, 0.5, 0.9];

/** Timestamps inside the clip (never past the last decodable frame), rounded to the millisecond. */
export function frameTimes(durationSec: number): number[] {
  const last = Math.max(0, durationSec - 0.05);
  return FRACTIONS.map(f => Math.round(Math.min(last, Math.max(0, durationSec * f)) * 1000) / 1000);
}

export type SampleFramesDeps = { ffmpeg?: FfmpegRunner; duration?: (file: string) => Promise<number>; width?: number };

/** Writes `<dir>/audit-<shotId>-<n>.png`; returns the files in time order. */
export async function sampleFrames(clip: string, dir: string, shotId: string, deps: SampleFramesDeps = {}): Promise<string[]> {
  const ffmpeg = deps.ffmpeg ?? ffmpegRunner();
  const duration = deps.duration ?? videoDuration;
  const width = deps.width ?? 768;
  const times = frameTimes(await duration(clip));
  const files = times.map((_, i) => join(dir, `audit-${shotId}-${i + 1}.png`));
  for (const [i, at] of times.entries()) {
    await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', clip,
      '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, files[i]!
    ]);
  }
  return files;
}

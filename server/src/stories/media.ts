import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ClipProbe } from './service.js';

const run = promisify(execFile);

/** bridge/py/assemble.py — shared by the Mac CLI and the server (Docker copies bridge/py). */
export const ASSEMBLER = process.env.STORY_ASSEMBLER
  ?? fileURLToPath(new URL('../../../bridge/py/assemble.py', import.meta.url));

export async function probeClip(file: string): Promise<ClipProbe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 30_000 });
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  const durationSec = Number(info.format?.duration);
  if (!Number.isFinite(durationSec)) throw new Error('ffprobe: no duration');
  return { durationSec, hasAudio: (info.streams ?? []).some(s => s.codec_type === 'audio') };
}

export async function assembleStory(dir: string): Promise<void> {
  try {
    // Low CPU priority: the VPS also serves other apps while a story assembles.
    await run('nice', ['-n', '10', process.env.STORY_PYTHON ?? 'python3', ASSEMBLER, dir], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    const detail = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim().split('\n').slice(-3).join(' ') || e.message || 'assembler failed';
    throw new Error(detail.slice(0, 500));
  }
}

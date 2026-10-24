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

/** Pixel size from the file header (PNG, JPEG, WEBP) — no image library needed. */
export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { open } = await import('node:fs/promises');
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    throw new Error('unknown image format');
  } finally {
    await fh.close();
  }
}

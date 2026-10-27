/**
 * Resized (webp) copies of images and posters of videos, made with ffmpeg and cached on disk
 * at <data>/cache/img/<sha1>.webp. The key covers path + mtime + size + inode + width, so a
 * replaced file (redrawn frame, re-assembled video) never serves a stale thumbnail.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sniffMediaType } from '../lib/media-type.js';

const exec = promisify(execFile);

export type FfmpegRunner = (args: string[]) => Promise<void>;

export function ffmpegRunner(bin = process.env.MEDIA_FFMPEG || 'ffmpeg'): FfmpegRunner {
  return async args => {
    await exec(bin, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  };
}

export const WIDTHS = [160, 320, 480, 720, 1080] as const;
/** Small thumbnails too (40–48 px reference chips: 64 at 1x, 96 at 2x); for uploaded images. */
export const THUMB_WIDTHS = [64, 96, ...WIDTHS] as const;

/** `?w=`: undefined when absent, null when not one of `widths`. */
export function parseWidth(value: unknown, widths: readonly number[] = WIDTHS): number | undefined | null {
  if (value === undefined) return undefined;
  const w = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  return widths.includes(w) ? w : null;
}

/** Versioned URLs (`v=`) never change; bare ones are re-checked after five minutes. */
export function cacheControl(query: unknown): string {
  const versioned = !!query && typeof query === 'object' && (query as Record<string, unknown>).v !== undefined;
  return versioned ? 'private, max-age=31536000, immutable' : 'private, max-age=300';
}

const MAX_PARALLEL = 2;

export async function videoDuration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 });
  const sec = Number(stdout.trim());
  if (!Number.isFinite(sec)) throw new Error('ffprobe: no duration');
  return sec;
}

export type MediaCacheDeps = { dataDir: string; ffmpeg?: FfmpegRunner; duration?: (file: string) => Promise<number> };

export class MediaCache {
  readonly dir: string;
  private readonly ffmpeg: FfmpegRunner;
  private readonly duration: (file: string) => Promise<number>;
  private readonly inflight = new Map<string, Promise<string>>();
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(deps: MediaCacheDeps) {
    this.dir = join(deps.dataDir, 'cache', 'img');
    this.ffmpeg = deps.ffmpeg ?? ffmpegRunner();
    this.duration = deps.duration ?? videoDuration;
  }

  /** Cached webp of `file` at `width` (never wider than the original). */
  async resized(file: string, width: number): Promise<string> {
    return this.cached(file, `w${width}`, out => [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-vf', `scale='min(${width},iw)':-2`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', out
    ]);
  }

  /** Cached webp of the frame at 1 s (the middle for clips under 2 s), optionally resized. */
  async poster(video: string, width?: number): Promise<string> {
    return this.cached(video, `poster${width ?? ''}`, async out => {
      const sec = await this.duration(video);
      const at = sec >= 2 ? 1 : Math.max(0, sec / 2);
      return [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', video,
        ...(width ? ['-vf', `scale='min(${width},iw)':-2`] : []),
        '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', out
      ];
    });
  }

  private async cached(file: string, variant: string, args: (out: string) => string[] | Promise<string[]>): Promise<string> {
    const info = await stat(file);
    const key = createHash('sha1').update(`${file}|${info.mtimeMs}|${info.size}|${info.ino}|${variant}`).digest('hex');
    const target = join(this.dir, `${key}.webp`);
    try {
      if ((await stat(target)).size > 0) return target;
    } catch { /* not cached yet */ }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.limited(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = join(this.dir, `${key}.${randomBytes(4).toString('hex')}.tmp.webp`);
      try {
        await this.ffmpeg(await args(tmp));
        await rename(tmp, target);
      } finally {
        await rm(tmp, { force: true });
      }
      return target;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** At most MAX_PARALLEL ffmpeg processes: a grid of 50 thumbnails must not fork 50 encoders. */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PARALLEL) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

const badWidth = (reply: FastifyReply, widths: readonly number[] = WIDTHS) =>
  reply.code(400).send({ error: { code: 'INVALID', message: `w must be one of ${widths.join(', ')}` } });

/**
 * Send an image file: original bytes (type from magic bytes) or, with `?w=` (one of `widths`), a
 * cached webp. The caller has checked that `file` exists.
 */
export async function sendImage(request: FastifyRequest, reply: FastifyReply, file: string, media: MediaCache, widths: readonly number[] = WIDTHS) {
  const query = request.query as Record<string, unknown> | undefined;
  const width = parseWidth(query?.w, widths);
  if (width === null) return badWidth(reply, widths);
  const path = width === undefined ? file : await media.resized(file, width);
  const type = width === undefined ? sniffMediaType(file) : 'image/webp';
  return reply.header('content-type', type).header('cache-control', cacheControl(query))
    .header('content-length', (await stat(path)).size).send(createReadStream(path));
}

/** Send the poster (webp) of a video; the caller has checked that `video` exists. */
export async function sendPoster(request: FastifyRequest, reply: FastifyReply, video: string, media: MediaCache) {
  const query = request.query as Record<string, unknown> | undefined;
  const width = parseWidth(query?.w);
  if (width === null) return badWidth(reply);
  const path = await media.poster(video, width);
  return reply.header('content-type', 'image/webp').header('cache-control', cacheControl(query))
    .header('content-length', (await stat(path)).size).send(createReadStream(path));
}

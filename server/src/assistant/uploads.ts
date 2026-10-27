/**
 * Image uploads of a story (character references, start frames): PNG, JPEG or WebP, at most
 * 10 MB, stored inside the story's own directory as `uploads/<uploadId>.<ext>`. The type comes
 * from the magic bytes (a Content-Type header proves nothing) and the pixel size from the file
 * header, without any image library. Ids and file names are validated on every read, so a
 * reference can never point outside `uploads/`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const UPLOAD_ID = /^up_[a-f0-9]{16}$/;
export const UPLOAD_FILE = /^up_[a-f0-9]{16}\.(png|jpg|webp)$/;
/** How a stored reference is written on a card or a shot: relative to the story dir. */
export const UPLOAD_REL = /^uploads\/up_[a-f0-9]{16}\.(png|jpg|webp)$/;

/** Shown verbatim when a body is not one of the three image types. */
export const NOT_IMAGE_MESSAGE = 'File harus gambar PNG, JPEG atau WebP.';
export const TOO_LARGE_MESSAGE = 'Gambar terlalu besar — maksimal 10 MB.';

export type ImageMime = (typeof UPLOAD_TYPES)[number];
export type ImageInfo = { mime: ImageMime; ext: 'png' | 'jpg' | 'webp'; w: number; h: number };
export type Upload = { id: string; file: string; w: number; h: number; bytes: number; mime: ImageMime };

const MIME_BY_EXT: Record<ImageInfo['ext'], ImageMime> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export const mimeOfFile = (file: string): ImageMime | undefined => MIME_BY_EXT[(file.split('.').pop() ?? '') as ImageInfo['ext']];

function pngSize(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Walk the JPEG markers to the first start-of-frame (baseline, progressive, lossless…). */
function jpegSize(buf: Buffer): { w: number; h: number } | undefined {
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = buf.readUInt16BE(i + 2);
    if (SOF.has(marker)) return i + 9 <= buf.length ? { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) } : undefined;
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

function webpSize(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Type and pixel size from the bytes; undefined for anything that is not a readable PNG/JPEG/WebP. */
export function imageInfo(buf: Buffer): ImageInfo | undefined {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return undefined;
  let size: { w: number; h: number } | undefined;
  let ext: ImageInfo['ext'];
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) { ext = 'png'; size = pngSize(buf); }
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { ext = 'jpg'; size = jpegSize(buf); }
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') { ext = 'webp'; size = webpSize(buf); }
  else return undefined;
  if (!size || !(size.w > 0 && size.h > 0)) return undefined;
  return { mime: MIME_BY_EXT[ext], ext, w: size.w, h: size.h };
}

export class UploadError extends Error {
  constructor(readonly code: 'NOT_IMAGE' | 'TOO_LARGE', message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export const uploadsDir = (storyDir: string) => join(storyDir, 'uploads');

/** Store an image body under a fresh random id; throws `UploadError` for a non-image or an oversized body. */
export async function saveUpload(storyDir: string, buf: Buffer): Promise<Upload> {
  if (Buffer.isBuffer(buf) && buf.length > MAX_UPLOAD_BYTES) throw new UploadError('TOO_LARGE', TOO_LARGE_MESSAGE);
  const info = imageInfo(buf);
  if (!info) throw new UploadError('NOT_IMAGE', NOT_IMAGE_MESSAGE);
  const id = `up_${randomBytes(8).toString('hex')}`;
  const file = `${id}.${info.ext}`;
  await mkdir(uploadsDir(storyDir), { recursive: true, mode: 0o700 });
  await writeFile(join(uploadsDir(storyDir), file), buf, { mode: 0o600 });
  return { id, file, w: info.w, h: info.h, bytes: buf.length, mime: info.mime };
}

/** A copy that is decided but not written yet: the bytes are read, the id and file name are fixed. */
export type PlannedUpload = Upload & { buf: Buffer };

/** Read an existing story image (a sheet, a keyframe) and pick its upload name; writes nothing. */
export async function planCopy(source: string): Promise<PlannedUpload | undefined> {
  if (!existsSync(source)) return undefined;
  const buf = await readFile(source);
  const info = imageInfo(buf);
  if (!info || buf.length > MAX_UPLOAD_BYTES) return undefined;
  const id = `up_${randomBytes(8).toString('hex')}`;
  return { id, file: `${id}.${info.ext}`, w: info.w, h: info.h, bytes: buf.length, mime: info.mime, buf };
}

/** Write a planned copy under its fixed name. */
export async function writePlanned(storyDir: string, planned: PlannedUpload): Promise<Upload> {
  await mkdir(uploadsDir(storyDir), { recursive: true, mode: 0o700 });
  await writeFile(join(uploadsDir(storyDir), planned.file), planned.buf, { mode: 0o600 });
  const { buf: _buf, ...upload } = planned;
  return upload;
}

/** Remove one upload file (a copy whose edit failed); a malformed or missing name is ignored. */
export async function removeUpload(storyDir: string, file: string): Promise<void> {
  if (!UPLOAD_FILE.test(file)) return;
  await rm(join(uploadsDir(storyDir), file), { force: true });
}

/** The stored file name of an upload id (`up_…`) or file name (`up_….png`, `uploads/up_….png`); undefined when malformed or missing. */
export function findUpload(storyDir: string, ref: string): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const name = ref.trim().replace(/^uploads\//, '');
  if (UPLOAD_FILE.test(name)) return existsSync(join(uploadsDir(storyDir), name)) ? name : undefined;
  if (!UPLOAD_ID.test(name)) return undefined;
  for (const ext of ['png', 'jpg', 'webp']) if (existsSync(join(uploadsDir(storyDir), `${name}.${ext}`))) return `${name}.${ext}`;
  return undefined;
}

/** Absolute path of a stored reference (`uploads/up_….ext`); undefined when malformed or missing. */
export function uploadPath(storyDir: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !UPLOAD_REL.test(rel)) return undefined;
  const path = join(storyDir, rel);
  return existsSync(path) ? path : undefined;
}

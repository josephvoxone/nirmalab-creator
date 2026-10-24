import { closeSync, openSync, readSync } from 'node:fs';

/** Content type from magic bytes — Flow names JPEGs `.png`, so extensions lie. */
export function sniffMediaType(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, 'r');
  try { readSync(fd, head, 0, 12, 0); } finally { closeSync(fd); }
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  return 'video/mp4';
}

/**
 * One copy on disk: a story file made from a job result is a hard link to
 * flow/clips/<file>. Across devices (EXDEV) or where links are unsupported, a copy.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, link as fsLink, rename, rm, stat } from 'node:fs/promises';

export type LinkOps = { link?: (src: string, dest: string) => Promise<void> };

/** link() errors that mean "no hard link possible here", not "something is wrong". */
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK']);

export const isNoLinkError = (error: unknown) => NO_LINK.has((error as NodeJS.ErrnoException)?.code ?? '');

/** Point `dest` at the bytes of `src` (replacing dest atomically). */
export async function linkOrCopy(src: string, dest: string, ops: LinkOps = {}): Promise<'linked' | 'copied' | 'same'> {
  const source = await stat(src);
  try {
    const current = await stat(dest);
    // rename() onto another name of the same file is a no-op that would leave the temp link behind.
    if (current.dev === source.dev && current.ino === source.ino) return 'same';
  } catch { /* no target yet */ }
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    let how: 'linked' | 'copied' = 'linked';
    try {
      await (ops.link ?? fsLink)(src, tmp);
    } catch (error) {
      if (!isNoLinkError(error)) throw error;
      await copyFile(src, tmp);
      how = 'copied';
    }
    await rename(tmp, dest);
    return how;
  } finally {
    await rm(tmp, { force: true });
  }
}

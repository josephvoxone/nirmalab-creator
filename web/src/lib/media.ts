/**
 * Sized server images (docs/providers-and-media.md §2): image endpoints answer `?w=` with a
 * webp of that width, for a fixed set of widths only. Ask for the smallest one that covers the
 * box so a 96 px thumbnail never downloads a 1080 px keyframe.
 */

export const IMAGE_WIDTHS = [160, 320, 480, 720, 1080] as const;
/** Uploaded images (references) also come in small thumbnail widths. */
export const UPLOAD_WIDTHS = [64, 96, ...IMAGE_WIDTHS] as const;

/** Smallest server width ≥ `px` (the largest when nothing is big enough). */
export function pickWidth(px: number, widths: readonly number[] = IMAGE_WIDTHS): number {
  return widths.find(w => w >= px) ?? widths[widths.length - 1]!;
}

/** `url` with `w=` for a box `w` CSS px wide; keeps the existing query (e.g. `v=`) and hash. */
export function sized(url: string, w: number, widths: readonly number[] = IMAGE_WIDTHS): string {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = base.indexOf('?');
  const path = q >= 0 ? base.slice(0, q) : base;
  const params = (q >= 0 ? base.slice(q + 1) : '').split('&').filter(Boolean);
  const width = `w=${pickWidth(w, widths)}`;
  const i = params.findIndex(p => p.split('=')[0] === 'w');
  if (i >= 0) params[i] = width; else params.push(width);
  return `${path}?${params.join('&')}${hash}`;
}

/** `src` for a box `cssW` px wide plus a 1x/2x `srcSet` when the 2x file is actually bigger. */
export function sizedImg(url: string, cssW: number, widths: readonly number[] = IMAGE_WIDTHS): { src: string; srcSet?: string } {
  const one = sized(url, cssW, widths);
  const two = sized(url, cssW * 2, widths);
  return one === two ? { src: one } : { src: one, srcSet: `${one} 1x, ${two} 2x` };
}

const versioned = (path: string, v?: string) => (v ? `${path}?v=${encodeURIComponent(v)}` : path);

/** Poster stills of a video (frame at 1 s), so a player is never a black box. 404 when there is no video. */
export const poster = {
  final: (storyId: string, w: number, v?: string) => sized(versioned(`/api/stories/${storyId}/video/poster`, v), w),
  shot: (storyId: string, shotId: string, w: number, v?: string) => sized(versioned(`/api/stories/${storyId}/shots/${shotId}/poster`, v), w)
};

/** Width of a player `maxH` px tall at `aspect`, for picking its poster size (2x for sharp screens). */
export const playerPosterWidth = (maxH: number, aspect?: string) => Math.round(maxH * (aspect === '16:9' ? 16 / 9 : 9 / 16) * 2);

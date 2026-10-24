/**
 * Instagram source — a JSON export produced by `instaloader`, read from disk. No scraping
 * happens in this process (spec §4.5: hashtag/reel publik saja, tanpa login akun pribadi).
 *
 * Why a file: Instagram blocks guest scraping from a server IP within a handful of requests,
 * and doing it in-process would mean shipping the user's session cookie into the app. Instead
 * an operator runs instaloader on demand (cron, once a day) against public hashtags and drops
 * the JSON where the app can read it:
 *
 *   mkdir -p /data/trends/ig
 *   instaloader --no-caption --no-pictures --no-video-thumbnails \
 *     --post-filter="post.date_utc >= datetime(2026, 10, 1)" \
 *     --dirname-pattern="/data/trends/ig/{target}" \
 *     "#aivideo" "#storytelling" "#faceless"
 *   # instaloader writes one <shortcode>.json per post; merge them into one export:
 *   jq -s '.' $(find /data/trends/ig -name '*.json') > /data/trends/ig/reels.json
 *
 * `TRENDS_IG_FILE` then points at `/data/trends/ig/reels.json` (a single JSON file) or at the
 * directory itself — both are accepted, so the merge step is optional.
 *
 * Accepted shapes: an array of posts, `{items:[...]}`, or a `{shortcode: post}` map; each post
 * either wrapped as `{node:{...}}` (instaloader's GraphQL answer) or flat. Anything else is
 * ignored rather than fatal: an export from a different instaloader release must not take the
 * trend page down.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, num, str, type FetchLike } from './http.js';
import { enrichSeeds } from './pipeline.js';
import type { TrendItem, TrendQuery, TrendSeed, TrendSource } from './types.js';

export const IG_MAX_POSTS = 100;

/** Caption text of an instaloader node, wherever that release put it. */
function captionOf(node: Record<string, unknown>): string {
  const edges = isObject(node.edge_media_to_caption) ? node.edge_media_to_caption.edges : undefined;
  if (Array.isArray(edges)) {
    const texts = edges
      .map(edge => (isObject(edge) && isObject(edge.node) ? str(edge.node.text, 2200) : ''))
      .filter(Boolean);
    if (texts.length) return texts.join(' ');
  }
  return str(node.caption, 2200) || str(node.title, 300);
}

const countOf = (value: unknown): number => (isObject(value) ? num(value.count) : num(value));

/**
 * One instaloader post → seed. A photo is dropped (the rail is video); everything numeric is
 * read from the GraphQL edges with the flat fields as fallback, because instaloader's JSON has
 * kept both for years.
 */
export function mapInstagramPost(raw: unknown, query: TrendQuery): TrendSeed | undefined {
  if (!isObject(raw)) return undefined;
  const node = isObject(raw.node) ? raw.node : raw;
  const shortcode = str(node.shortcode, 60) || str(node.code, 60);
  const id = str(node.id, 40) || shortcode;
  if (!id) return undefined;
  const isVideo = node.is_video === true || num(node.video_view_count) > 0 || num(node.video_duration) > 0;
  if (!isVideo) return undefined;

  const caption = captionOf(node);
  const owner = isObject(node.owner) ? node.owner : isObject(node.user) ? node.user : {};
  const takenAt = num(node.taken_at_timestamp);
  const publishedAtMs = takenAt > 0
    ? Math.round(takenAt * 1000)
    : (() => {
      const parsed = Date.parse(str(node.taken_at, 40));
      return Number.isFinite(parsed) ? parsed : 0;
    })();
  const type = str(node.__typename, 40).toUpperCase().includes('REEL') || str(node.product_type, 40).toUpperCase() === 'CLIPS'
    ? 'reel'
    : 'p';
  const line = caption.split(/\n/)[0] ?? '';

  return {
    id,
    source: 'instagram',
    title: str(line, 300) || '(tanpa caption)',
    channel: str(owner.username, 80),
    url: shortcode ? `https://www.instagram.com/${type}/${shortcode}/` : '',
    thumbnail: str(node.display_url, 500) || str(node.thumbnail_src, 500),
    views: num(node.video_view_count) || num(node.video_play_count),
    likes: countOf(node.edge_media_preview_like) || countOf(node.edge_liked_by) || num(node.likes),
    comments: countOf(node.edge_media_to_comment) || countOf(node.edge_media_to_parent_comment) || num(node.comments),
    publishedAtMs,
    durationSec: num(node.video_duration),
    // Instagram states no region: the query's region is the only honest value.
    region: query.region,
    ...(caption ? { description: caption } : {})
  };
}

/** The post array inside any accepted export shape. */
export function instagramPosts(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObject(raw)) return [];
  for (const key of ['items', 'posts', 'data']) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
    if (isObject(value)) return instagramPosts(value);
  }
  // A shortcode → post map (a merged export keyed by hand).
  const values = Object.values(raw);
  return values.length && values.every(isObject) ? values : [];
}

/** Parse an export from a file or a directory of instaloader JSON files. Never throws. */
export async function readInstagramExport(path: string): Promise<unknown[]> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      const names = (await readdir(path, { recursive: true })).filter(name => name.toLowerCase().endsWith('.json')).sort();
      const out: unknown[] = [];
      for (const name of names.slice(0, IG_MAX_POSTS)) {
        try {
          out.push(...instagramPosts(JSON.parse(await readFile(join(path, name), 'utf8')) as unknown));
        } catch {
          // One unreadable file must not lose the other 99.
        }
      }
      return out;
    }
    return instagramPosts(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return [];
  }
}

export type InstagramOptions = {
  /** `TRENDS_IG_FILE`: a `.json` export, or the instaloader output directory. */
  file?: string;
  /** Unused by the file path; kept so the source can share the app's fetch injection signature. */
  fetch?: FetchLike;
};

export function createInstagramSource(options: InstagramOptions = {}): TrendSource {
  const file = options.file?.trim() ?? '';
  return {
    id: 'instagram',
    configured: () => file.length > 0,
    async fetch(query: TrendQuery): Promise<TrendItem[]> {
      if (!file) return [];
      const posts = await readInstagramExport(file);
      const seeds = posts
        .map(post => mapInstagramPost(post, query))
        .filter((seed): seed is TrendSeed => !!seed)
        .slice(0, IG_MAX_POSTS);
      return enrichSeeds(seeds, query);
    }
  };
}

/**
 * Instagram source — plain instaloader JSON on disk. No network at all: the file is the
 * boundary, which is also why these tests can use a temp directory.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstagramSource, instagramPosts, mapInstagramPost, readInstagramExport } from '../src/trends/instagram.js';

const NOW = 1_792_929_600_000;
const FIXTURE = new URL('./fixtures/trends/instagram-export.json', import.meta.url).pathname;

const exported = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;

describe('export shapes', () => {
  it('accepts an array, {items}, {posts}, a shortcode map and a nested data wrapper', () => {
    expect(instagramPosts([{ id: '1' }])).toEqual([{ id: '1' }]);
    expect(instagramPosts({ items: [{ id: '2' }] })).toEqual([{ id: '2' }]);
    expect(instagramPosts({ posts: [{ id: '3' }] })).toEqual([{ id: '3' }]);
    expect(instagramPosts({ data: [{ id: '4' }] })).toEqual([{ id: '4' }]);
    expect(instagramPosts({ CxAbC: { id: '5' }, CxAbD: { id: '6' } })).toEqual([{ id: '5' }, { id: '6' }]);
    expect(instagramPosts('nope')).toEqual([]);
    expect(instagramPosts(null)).toEqual([]);
  });
});

describe('post mapping', () => {
  it('maps an instaloader node onto the seed shape', () => {
    const seed = mapInstagramPost((exported() as unknown[])[0], { region: 'ID', windowHours: 720 });
    expect(seed).toMatchObject({
      id: '3111111111111111111',
      source: 'instagram',
      title: 'Sebelum vs sesudah: kamar anak jadi hutan. Simpan buat ide!',
      channel: 'ceritapagi',
      url: 'https://www.instagram.com/reel/CxAbCdEf001/',
      thumbnail: 'https://scontent.example-cdn.invalid/v/cover-01.jpg',
      views: 480_000,
      likes: 61_000,
      comments: 1_290,
      durationSec: 22.4,
      region: 'ID'
    });
    expect(seed!.publishedAtMs).toBe(NOW - 27 * 3_600_000);
  });

  it('drops a photo: the rail is video, so a still must not become a zeroed card', () => {
    const photo = (exported() as unknown[])[2];
    expect(mapInstagramPost(photo, { region: 'ID', windowHours: 24 })).toBeUndefined();
  });

  it('ignores junk instead of throwing', () => {
    expect(mapInstagramPost(null, { region: 'ID', windowHours: 24 })).toBeUndefined();
    expect(mapInstagramPost({ node: { is_video: true } }, { region: 'ID', windowHours: 24 })).toBeUndefined();
  });
});

describe('Instagram source', () => {
  it('is not configured without TRENDS_IG_FILE and reads nothing', async () => {
    const source = createInstagramSource({});
    expect(source.id).toBe('instagram');
    expect(source.configured()).toBe(false);
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });

  it('reads the export file and scores what is inside it', async () => {
    const source = createInstagramSource({ file: FIXTURE });
    expect(source.configured()).toBe(true);
    const items = await source.fetch({ region: 'ID', windowHours: 720, niche: 'ai', nowMs: NOW });

    expect(items).toHaveLength(2);
    expect(items.map(item => item.id).sort()).toEqual(['3111111111111111111', '3222222222222222222']);
    const first = items.find(item => item.id === '3111111111111111111')!;
    expect(first).toMatchObject({
      source: 'instagram',
      hook: 'before-after',
      audioType: 'musik',
      captionStyle: 'tanpa-caption',
      durationSec: 22,
      shotCount: 6
    });
    expect(first.velocity).toBe(17_777.8); // 480 000 views over 27 h
    expect(first.engagement).toBeCloseTo(0.1298, 4);
    const second = items.find(item => item.id === '3222222222222222222')!;
    // Flat node: likes/comments arrive on the other edges.
    expect(second).toMatchObject({ views: 1_200_000, likes: 88_000, comments: 3_100, durationSec: 15, url: 'https://www.instagram.com/p/CxAbCdEf002/' });
  });

  it('applies the window', async () => {
    const source = createInstagramSource({ file: FIXTURE });
    expect(await source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).toEqual([]);
    expect(await source.fetch({ region: 'ID', windowHours: 168, nowMs: NOW })).toHaveLength(1);
  });

  it('also reads a directory of per-post instaloader files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ig-'));
    const posts = exported() as unknown[];
    writeFileSync(join(dir, 'CxAbCdEf001.json'), JSON.stringify([posts[0]]));
    writeFileSync(join(dir, 'CxAbCdEf002.json'), JSON.stringify([posts[1]]));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(await readInstagramExport(dir)).toHaveLength(2);

    const items = await createInstagramSource({ file: dir }).fetch({ region: 'ID', windowHours: 720, nowMs: NOW });
    expect(items).toHaveLength(2);
  });

  it('fails soft on a missing file, a bad file or a bad entry', async () => {
    expect(await readInstagramExport('/nonexistent/ig.json')).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'oc-ig-bad-'));
    writeFileSync(join(dir, 'broken.json'), '{not json');
    expect(await readInstagramExport(join(dir, 'broken.json'))).toEqual([]);
    await expect(createInstagramSource({ file: join(dir, 'broken.json') }).fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });
});

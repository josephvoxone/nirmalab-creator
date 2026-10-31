/**
 * P4: the caption a publisher sees in the preview is generated from the story's own facts
 * (concrete first line → one tension → one payoff), never from adjectives.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthStore } from '../src/auth/store.js';
import { captionFor } from '../src/stories/caption.js';
import { lintCopy } from '../src/text/lint.js';
import { registerPublisherRoutes, type PublisherService } from '../src/publisher/index.js';
import { buildApp } from '../src/app.js';

const story = {
  title: 'Jingga di Pagar',
  logline: 'Jingga menunggu pemiliknya yang pindah ke kota lain setiap sore di depan pagar.',
  kicker: 'Kucing oranye',
  template: 'drama-hewan',
  lines: [
    'Jingga duduk di depan pagar kayu.',
    'Truk pindahan pergi meninggalkan kampung.',
    'Jingga menunggu sampai pemiliknya kembali menjemput.'
  ]
};

describe('captionFor', () => {
  it('builds three lines: a concrete hook, one tension, one payoff', () => {
    const caption = captionFor(story);
    const lines = caption.split('\n').filter(line => line.trim() && !line.startsWith('#'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Jingga');
    expect(lines[1]).toContain('pindah');
    expect(lines[2]).toContain('menjemput');
    expect(caption).toContain('#');
  });

  it('passes the caption lint: no adjectives, no tells, a concrete subject', () => {
    expect(lintCopy(captionFor(story), { kind: 'caption' })).toEqual([]);
  });

  it('never repeats the same line twice, even when the source repeats it', () => {
    const caption = captionFor({ ...story, lines: [story.lines[0]!, story.lines[0]!, story.logline] });
    const lines = caption.split('\n').filter(line => line.trim() && !line.startsWith('#'));
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('drops a slop line instead of shipping it', () => {
    const caption = captionFor({ ...story, logline: 'Dalam dunia yang indah, mari kita simak kisah ini!!' });
    expect(caption).not.toMatch(/dalam dunia yang|mari kita|simak|\bindah\b|!!/i);
    expect(lintCopy(caption, { kind: 'caption' })).toEqual([]);
  });

  it('never invents a tension for a story that has none', () => {
    const caption = captionFor({ title: 'Hujan Pertama' });
    expect(caption).not.toMatch(/tapi|namun|ternyata/i);
    expect(caption.length).toBeGreaterThan(3);
    expect(lintCopy(caption, { kind: 'caption' })).toEqual([]);
  });

  it('is deterministic and stays inside the Instagram caption budget', () => {
    expect(captionFor(story)).toBe(captionFor(story));
    expect(captionFor(story).length).toBeLessThanOrEqual(2200);
    expect((captionFor(story).match(/#/g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it('trims a narration line that is over the 12-word beat budget', () => {
    const caption = captionFor({ ...story, lines: ['Jingga menunggu di depan pagar kayu setiap sore sampai pemiliknya kembali menjemputnya di kampung yang sudah sepi itu.'] });
    const first = caption.split('\n')[0]!;
    expect(first.split(/\s+/).length).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// preview route (what the publish page reads before a human edits the caption)
// ---------------------------------------------------------------------------

async function setup(resolveStoryPreview?: (id: string) => Promise<{ title: string; caption: string } | undefined>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-cap-'));
  const userAuthStore = new UserAuthStore(dataDir);
  const admin = await userAuthStore.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await userAuthStore.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const service = { publish: vi.fn(), handleCallback: vi.fn() } as unknown as PublisherService;
  const server = Fastify();
  await registerPublisherRoutes(server, { service, userAuthStore, env: {}, resolveStoryPreview, canAccessStory: async () => true });
  await server.ready();
  const cookie = (id: string) => `oc_session=${userAuthStore.createSession(id).token}`;
  return { server, adminCookie: cookie(admin.id), memberCookie: cookie(member.id) };
}

describe('GET /api/publish/preview/:storyId', () => {
  it('returns the title and a lint-clean caption for a finished story', async () => {
    const { server, adminCookie } = await setup(async id => (id === 'story_0123456789abcdef' ? { title: story.title, caption: captionFor(story) } : undefined));
    const res = await server.inject({ url: '/api/publish/preview/story_0123456789abcdef', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Jingga di Pagar');
    expect(res.json().caption).toContain('Jingga');
  });

  it('answers 404 for an unknown story and 400 for a malformed id', async () => {
    const { server, adminCookie } = await setup(async () => undefined);
    expect((await server.inject({ url: '/api/publish/preview/story_ffffffffffffffff', headers: { cookie: adminCookie } })).statusCode).toBe(404);
    expect((await server.inject({ url: '/api/publish/preview/bukan-story', headers: { cookie: adminCookie } })).statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const { server } = await setup(async () => ({ title: 't', caption: 'c' }));
    expect((await server.inject({ url: '/api/publish/preview/story_0123456789abcdef' })).statusCode).toBe(401);
  });

  it('is readable by a member who owns the story (preview only, publishing stays admin)', async () => {
    const { server, memberCookie } = await setup(async () => ({ title: 't', caption: 'c' }));
    expect((await server.inject({ url: '/api/publish/preview/story_0123456789abcdef', headers: { cookie: memberCookie } })).statusCode).toBe(200);
  });
});

describe('buildApp wires the preview to the story service', () => {
  it('answers 404 for a story that has no finished video, without inventing a caption', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-capapp-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(10)) }
    });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const board = { title: 'Jingga di Pagar', logline: 'Jingga menunggu pemiliknya setiap sore.', caption: 'Jingga duduk di pagar.\nTruk pindah pergi.\nIa menunggu.', audio: 'Audio: "{line}"', shots: [{ id: '00-a', narration: 'Jingga duduk di pagar.', prompt: 'Wide shot of a village gate.' }] };
    const story = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story;
    const res = await server.inject({ url: `/api/publish/preview/${story.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

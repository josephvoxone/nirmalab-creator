/**
 * T8.5 — the admin routes never read the CONTENT of a project. Every `readFile` of `node:fs/promises` is recorded while the admin
 * calls every new route and /api/storage; only `story.json` of a project (and the auth/log/limit files) may be opened.
 */
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ paths: [] as string[], on: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((...args: Parameters<typeof real.readFile>) => { if (reads.on) reads.paths.push(String(args[0])); return real.readFile(...args); }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

const { adminWorld, SECRET, storyId, writeStory } = await import('./admin-world.js');

let server: FastifyInstance | undefined;
afterEach(async () => { reads.on = false; await server?.close(); server = undefined; });

describe('T8.5 the console never opens the content of a live (or orphaned) project', () => {
  it('reads nothing but story.json under stories/, and no response carries a live project\'s title, prompt, narration, chat or dub text', async () => {
    const w = await adminWorld(); server = w.server;
    const mira = await w.addUser('mira@x.io');
    const bina = await w.addUser('bina@x.io');
    const live = storyId(); writeStory(w.dataDir, { id: live, ownerId: mira.user.id });
    const orphan = storyId(); writeStory(w.dataDir, { id: orphan, ownerId: bina.user.id, title: 'Yatim Biasa' });
    await w.req('DELETE', `/api/auth/members/${bina.user.id}`);
    reads.paths.length = 0; reads.on = true;
    const bodies: string[] = [];
    for (const [method, url, payload] of [
      ['GET', '/api/admin/projects'], ['GET', '/api/storage'], ['GET', '/api/admin/usage'], ['GET', `/api/admin/users/${mira.user.id}/limits`], ['GET', '/api/admin/audit-log'],
      ['POST', `/api/admin/projects/${orphan}/transfer`, { toUserId: w.admin.id }], ['POST', `/api/admin/projects/${live}/transfer`, { toUserId: w.admin.id }],
      ['DELETE', `/api/admin/projects/${live}`, { confirmTitle: SECRET.title }], ['GET', '/api/auth/members']
    ] as const) {
      const res = await w.req(method, url, undefined, payload);
      bodies.push(res.body);
    }
    reads.on = false;
    const storyReads = reads.paths.filter(p => p.includes(`${join('data', '')}`) || p.includes('/stories/'));
    expect(storyReads.length).toBeGreaterThan(0);
    for (const path of storyReads) expect(path.endsWith('/story.json'), path).toBe(true);
    expect(reads.paths.filter(p => /storyboard\.json|assistant\.json|dub\.json|snapshots|uploads|\.mp4$/.test(p))).toEqual([]);
    const all = bodies.join('\n');
    for (const secret of [SECRET.title, SECRET.prompt, SECRET.narration, SECRET.chat, SECRET.dub]) expect(all, secret).not.toContain(secret);
    // the live project's id is not in any response either (the transfer/delete 409 answers do not echo it)
    expect(all).not.toContain(live);
  });
});

/**
 * T3 §5 — Joseph (the admin who owns the projects) loses nothing. The fixture mirrors production at wave 3: two accounts (Joseph, admin and
 * oldest; a member with an empty workspace), 6 projects that were made before ownership was recorded (no `createdBy`), and one orphan whose
 * creator account no longer exists. After the gate: Joseph lists, opens, watches, dubs-reads, assembles and previews all six, with and
 * without the boot attribution having run; the member sees none; the orphan is nobody's (only the admin routes of T8 will touch it).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import { bibleBoard } from './bible-board.js';

const open: Array<{ close(): Promise<unknown> }> = [];
afterAll(async () => { while (open.length) await open.pop()!.close().catch(() => undefined); });
let seq = 0;

async function production(env: Record<string, string> = {}) {
  const n = ++seq;
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-joseph-'));
  const users = new UserAuthStore(dataDir);
  const joseph = await users.createUser({ email: `joseph${n}@example.com`, password: 'joseph-pass-1', isAdmin: true });
  await new Promise(r => setTimeout(r, 5));
  const member = await users.createUser({ email: `elfree${n}@gmail.com`, password: 'member-pass-1', isAdmin: false });
  const service = new StoryService({ dataDir, flow: new FlowStore(join(dataDir, 'flow')), probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1)); } });
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    // Made before ownership was recorded: no createdBy at all.
    const record = await service.create({ ...bibleBoard(), title: i === 1 ? 'Lentera' : `Proyek ${i}` });
    const dir = service.storyDir(record.id);
    const json = JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
    writeFileSync(join(dir, 'story.json'), JSON.stringify({ ...json, status: 'done', video: { bytes: 64, finishedAtMs: Date.now() } }));
    writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1));
    writeFileSync(join(dir, '01-laras.mp4'), Buffer.alloc(64, 2));
    mkdirSync(join(dir, 'dub'), { recursive: true });
    writeFileSync(join(dir, 'dub.json'), JSON.stringify({ version: 1, settings: {}, shots: { '01-laras': { status: 'done', file: 'dub/x.mp3', text: 'halo' } } }));
    writeFileSync(join(dir, 'dub', 'x.mp3'), Buffer.from('MP3'));
    ids.push(record.id);
  }
  const orphan = await service.create({ ...bibleBoard(), title: 'Yatim' }, { createdBy: 'u_account_deleted' });
  const server = await buildApp({
    dataDir, env: { ...env }, stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1)); } },
    providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 }
  });
  open.push(server);
  const login = async (email: string, password: string) => String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
  return { server, dataDir, ids, orphan: orphan.id, joseph: { id: joseph.id, cookie: await login(joseph.email, 'joseph-pass-1') }, member: { id: member.id, cookie: await login(member.email, 'member-pass-1') } };
}

const everyOwnerRoute = (id: string) => [
  ['GET', `/api/stories/${id}`], ['GET', `/api/stories/${id}/video`], ['GET', `/api/stories/${id}/dub`], ['GET', `/api/stories/${id}/dub/shots/01-laras/audio`],
  ['GET', `/api/stories/${id}/assistant`], ['GET', `/api/publish/preview/${id}`], ['GET', `/api/stories/${id}/shots/01-laras/video`]
] as const;

describe('T3 Joseph (admin owner) keeps all six projects', () => {
  for (const [label, env] of [['boot attribution ran (normal)', {}], ['boot attribution did NOT run (TENANCY_MIGRATE=0): the legacy-owner fallback keeps them his', { TENANCY_MIGRATE: '0' }]] as const) {
    it(`${label}: list, open, watch, dub, assistant history, publish preview and write routes work for him; the member sees nothing; the orphan is nobody's`, async () => {
      const w = await production(env);
      const list = (await w.server.inject({ url: '/api/stories', headers: { cookie: w.joseph.cookie } })).json().stories as Array<{ id: string; title: string }>;
      expect(list.map(s => s.id).sort()).toEqual([...w.ids].sort());
      expect(list.map(s => s.title)).toContain('Lentera');
      expect(list.map(s => s.id)).not.toContain(w.orphan);
      for (const id of w.ids) {
        for (const [method, url] of everyOwnerRoute(id)) {
          const res = await w.server.inject({ method, url, headers: { cookie: w.joseph.cookie } });
          expect(res.statusCode, `${method} ${url}`).toBeLessThan(400);
        }
        // the member: nothing of Joseph's is reachable
        for (const [method, url] of everyOwnerRoute(id)) expect((await w.server.inject({ method, url, headers: { cookie: w.member.cookie } })).statusCode, `member ${url}`).toBe(404);
      }
      const first = w.ids[0]!;
      // write routes (Joseph is an admin, not a bystander): dub settings, look, assemble, delete are reachable for him
      expect((await w.server.inject({ method: 'PUT', url: `/api/stories/${first}/dub/settings`, headers: { cookie: w.joseph.cookie }, payload: { voiceId: 'voice_joseph' } })).statusCode).toBe(200);
      expect((await w.server.inject({ method: 'POST', url: `/api/stories/${first}/assemble`, headers: { cookie: w.joseph.cookie }, payload: {} })).statusCode).not.toBe(404);
      expect((await w.server.inject({ method: 'POST', url: `/api/stories/${first}/assistant`, headers: { cookie: w.joseph.cookie }, payload: { message: '' } })).statusCode).toBe(400);
      expect((await w.server.inject({ url: '/api/stories', headers: { cookie: w.member.cookie } })).json().stories).toEqual([]);
      for (const who of [w.joseph, w.member]) expect((await w.server.inject({ url: `/api/stories/${w.orphan}`, headers: { cookie: who.cookie } })).statusCode).toBe(404);
      const afterDelete = await w.server.inject({ method: 'DELETE', url: `/api/stories/${w.ids[5]}`, headers: { cookie: w.joseph.cookie } });
      expect(afterDelete.statusCode).toBe(200);
      expect(existsSync(join(w.dataDir, 'stories', w.ids[5]!))).toBe(false);
    }, 60_000);
  }

  it('boot attribution writes Joseph as the owner of the six (so a later member/admin change cannot detach them)', async () => {
    const w = await production();
    for (const id of w.ids) expect(JSON.parse(readFileSync(join(w.dataDir, 'stories', id, 'story.json'), 'utf8')).createdBy).toBe(w.joseph.id);
    expect(JSON.parse(readFileSync(join(w.dataDir, 'stories', w.orphan, 'story.json'), 'utf8')).createdBy).toBe('u_account_deleted');
  });
});

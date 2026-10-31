import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { adminWorld, SECRET, storyId, writeStory } from './admin-world.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
async function world() { const w = await adminWorld(); server = w.server; return w; }
const folderBytes = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? folderBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);

/** admin + a live member with two projects + an orphan (its owner was removed through the real route). */
async function seeded() {
  const w = await world();
  const mira = await w.addUser('mira@x.io');
  const bina = await w.addUser('bina@x.io');
  const live = [storyId(), storyId()];
  writeStory(w.dataDir, { id: live[0]!, ownerId: mira.user.id, extraBytes: 4000 });
  writeStory(w.dataDir, { id: live[1]!, ownerId: mira.user.id, extraBytes: 500, title: 'Judul Rahasia Kedua' });
  const mine = storyId(); writeStory(w.dataDir, { id: mine, ownerId: w.admin.id, title: 'Punya Admin', extraBytes: 100 });
  const orphan = storyId(); writeStory(w.dataDir, { id: orphan, ownerId: bina.user.id, title: 'Kakek Hilang Perahu', extraBytes: 2500, status: 'done', createdAtMs: 1_700_100_000_000, updatedAtMs: 1_700_200_000_000 });
  const loose = storyId(); writeStory(w.dataDir, { id: loose, title: 'Tanpa Pemilik', extraBytes: 10 });
  await w.req('DELETE', `/api/auth/members/${bina.user.id}`);
  return { w, mira, bina, live, mine, orphan, loose };
}

describe('T8 gate: every new admin route is admin-only', () => {
  it('anonymous = 401, member = 403 on every route, and no body leaks', async () => {
    const t = await seeded();
    const calls: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/admin/projects'], ['POST', `/api/admin/projects/${t.orphan}/transfer`, { toUserId: t.mira.user.id }], ['DELETE', `/api/admin/projects/${t.orphan}`, { confirmTitle: 'Kakek Hilang Perahu' }],
      ['GET', '/api/admin/usage'], ['GET', `/api/admin/users/${t.mira.user.id}/limits`], ['PUT', `/api/admin/users/${t.mira.user.id}/limits`, { limits: {} }],
      ['GET', '/api/admin/audit-log'], ['POST', `/api/admin/users/${t.mira.user.id}/suspend`, {}], ['POST', `/api/admin/users/${t.mira.user.id}/activate`, {}]
    ];
    for (const [method, url, payload] of calls) {
      const anon = await t.w.req(method, url, '', payload);
      expect(anon.statusCode, `anon ${method} ${url}`).toBe(401);
      const member = await t.w.req(method, url, t.mira.cookie, payload);
      expect(member.statusCode, `member ${method} ${url}`).toBe(403);
      expect(member.body, url).not.toContain('Kakek');
    }
    expect(existsSync(join(t.w.dataDir, 'stories', t.orphan))).toBe(true);
    expect(t.w.auth.findUserById(t.mira.user.id)?.suspendedAt).toBeUndefined();
  });
});

describe('T8 GET /api/admin/projects — usage per owner WITHOUT titles, orphans WITH metadata', () => {
  it('lists owners with counts and bytes only, and the orphans (removed owner by tombstone email, and the ownerless one)', async () => {
    const t = await seeded();
    const res = await t.w.req('GET', '/api/admin/projects');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['orphans', 'owners', 'totals']);
    const mira = body.owners.find((o: { userId: string }) => o.userId === t.mira.user.id);
    expect(Object.keys(mira).sort()).toEqual(['bytes', 'email', 'isAdmin', 'lastActivityMs', 'projects', 'userId'].concat('suspendedAt' in mira ? ['suspendedAt'] : []).sort());
    expect(mira).toMatchObject({ email: t.mira.user.email, isAdmin: false, projects: 2 });
    expect(mira.bytes).toBe(t.live.reduce((n, id) => n + folderBytes(join(t.w.dataDir, 'stories', id)), 0));
    expect(mira.lastActivityMs).toBe(1_700_000_500_000);
    expect(body.owners.map((o: { email: string }) => o.email).sort()).toEqual([t.w.adminEmail, t.mira.user.email].sort());
    // no owner row for a removed member, and every live user has one (even with no projects)
    expect(body.owners.find((o: { userId: string }) => o.userId === t.bina.user.id)).toBeUndefined();
    // orphans: the only titles an admin sees
    const ids = body.orphans.map((o: { id: string }) => o.id).sort();
    expect(ids).toEqual([t.orphan, t.loose].sort());
    const orphan = body.orphans.find((o: { id: string }) => o.id === t.orphan);
    expect(Object.keys(orphan).sort()).toEqual(['bytes', 'createdAtMs', 'id', 'ownerEmail', 'ownerId', 'status', 'title', 'updatedAtMs']);
    expect(orphan).toMatchObject({ title: 'Kakek Hilang Perahu', ownerId: t.bina.user.id, ownerEmail: t.bina.user.email, status: 'done', createdAtMs: 1_700_100_000_000, updatedAtMs: 1_700_200_000_000 });
    expect(orphan.bytes).toBe(folderBytes(join(t.w.dataDir, 'stories', t.orphan)));
    expect(body.orphans.find((o: { id: string }) => o.id === t.loose)).toMatchObject({ title: 'Tanpa Pemilik', ownerId: null, ownerEmail: null });
    expect(body.totals).toMatchObject({ projects: 5, orphans: 2 });
  });

  it('never shows the title, prompt, narration, chat or dub text of a LIVE project (exact key set + sentinel scan of the whole body)', async () => {
    const t = await seeded();
    const body = (await t.w.req('GET', '/api/admin/projects')).body;
    for (const secret of [SECRET.title, 'Judul Rahasia Kedua', 'Punya Admin', SECRET.prompt, SECRET.narration, SECRET.chat, SECRET.dub]) expect(body, secret).not.toContain(secret);
    for (const key of ['storyboard', 'shots', 'events', 'assistant', 'prompt', 'narration']) expect(body, key).not.toContain(`"${key}"`);
    for (const id of t.live) expect(body).not.toContain(id); // not even a live project's id
  });
});

describe('T8 POST /api/admin/projects/:id/transfer — an orphan goes to a living user, nothing else changes', () => {
  it('writes createdBy + transferredFrom/At/By only; other fields and the private files stay byte-identical; Flow jobs of the project follow', async () => {
    const t = await seeded();
    const dir = join(t.w.dataDir, 'stories', t.orphan);
    const before = JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
    const privateBefore = ['storyboard.json', 'assistant.json', 'dub.json', '00-a.mp4'].map(f => readFileSync(join(dir, f)).toString('base64'));
    const flow = new FlowStore(join(t.w.dataDir, 'flow'));
    const j1 = await flow.createJob({ prompt: 'x', kind: 'image', group: t.orphan, createdBy: t.bina.user.id });
    const j2 = await flow.createJob({ prompt: 'y', kind: 'image', group: t.live[0]!, createdBy: t.mira.user.id });
    const res = await t.w.req('POST', `/api/admin/projects/${t.orphan}/transfer`, undefined, { toUserId: t.mira.user.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, id: t.orphan, toUserId: t.mira.user.id, jobsReassigned: 1 });
    const after = JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
    const { createdBy, transferredFrom, transferredAt, transferredBy, ...rest } = after;
    const { createdBy: oldOwner, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
    expect(createdBy).toBe(t.mira.user.id);
    expect(oldOwner).toBe(t.bina.user.id);
    expect(transferredFrom).toBe(t.bina.user.id);
    expect(transferredBy).toBe(t.w.admin.id);
    expect(transferredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(['storyboard.json', 'assistant.json', 'dub.json', '00-a.mp4'].map(f => readFileSync(join(dir, f)).toString('base64'))).toEqual(privateBefore);
    expect((await flow.getJob(j1.id))?.createdBy).toBe(t.mira.user.id);
    expect((await flow.getJob(j2.id))?.createdBy).toBe(t.mira.user.id);
    // the orphan list shrinks, mira's count grows; the new owner can see it (it is hers now)
    const list = (await t.w.req('GET', '/api/admin/projects')).json();
    expect(list.orphans.map((o: { id: string }) => o.id)).toEqual([t.loose]);
    expect(list.owners.find((o: { userId: string }) => o.userId === t.mira.user.id).projects).toBe(3);
  });

  it('refuses a project whose owner is alive (409 BUKAN_YATIM), unknown or malformed ids (404), an unknown or suspended target, and a missing body', async () => {
    const t = await seeded();
    const live = await t.w.req('POST', `/api/admin/projects/${t.live[0]}/transfer`, undefined, { toUserId: t.w.admin.id });
    expect(live.statusCode).toBe(409);
    expect(live.json().error.code).toBe('BUKAN_YATIM');
    expect(live.body).not.toContain(SECRET.title);
    expect(JSON.parse(readFileSync(join(t.w.dataDir, 'stories', t.live[0]!, 'story.json'), 'utf8')).createdBy).toBe(t.mira.user.id);
    expect((await t.w.req('POST', `/api/admin/projects/story_${'0'.repeat(16)}/transfer`, undefined, { toUserId: t.mira.user.id })).statusCode).toBe(404);
    expect((await t.w.req('POST', '/api/admin/projects/..%2Fauth/transfer', undefined, { toUserId: t.mira.user.id })).statusCode).toBe(404);
    expect((await t.w.req('POST', `/api/admin/projects/${t.orphan}/transfer`, undefined, { toUserId: 'u_gone' })).json().error.code).toBe('PENGGUNA_TIDAK_ADA');
    expect((await t.w.req('POST', `/api/admin/projects/${t.orphan}/transfer`, undefined, {})).statusCode).toBe(400);
    t.w.auth.setSuspended(t.mira.user.id, true, t.w.admin.id);
    const susp = await t.w.req('POST', `/api/admin/projects/${t.orphan}/transfer`, undefined, { toUserId: t.mira.user.id });
    expect(susp.statusCode).toBe(409);
    expect(susp.json().error.code).toBe('AKUN_DITANGGUHKAN');
    // the ownerless project can be given an owner too
    expect((await t.w.req('POST', `/api/admin/projects/${t.loose}/transfer`, undefined, { toUserId: t.w.admin.id })).statusCode).toBe(200);
    // a second transfer of the same project is not an orphan any more
    expect((await t.w.req('POST', `/api/admin/projects/${t.loose}/transfer`, undefined, { toUserId: t.w.admin.id })).statusCode).toBe(409);
  });
});

describe('T8 DELETE /api/admin/projects/:id — only an orphan, only with the title typed, always on the record', () => {
  it('needs {confirmTitle} equal to the title; wrong or missing = 400 and nothing is deleted', async () => {
    const t = await seeded();
    for (const payload of [undefined, {}, { confirmTitle: 'kakek hilang perahu' }, { confirmTitle: 'Kakek' }, { confirmTitle: 5 }]) {
      const res = await t.w.req('DELETE', `/api/admin/projects/${t.orphan}`, undefined, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('KONFIRMASI_SALAH');
    }
    expect(existsSync(join(t.w.dataDir, 'stories', t.orphan))).toBe(true);
  });

  it('deletes the orphan folder, writes the grave {id,title,ownerEmail,bytes,by,atMs} first, and a repeat is 404', async () => {
    const t = await seeded();
    const bytes = folderBytes(join(t.w.dataDir, 'stories', t.orphan));
    const res = await t.w.req('DELETE', `/api/admin/projects/${t.orphan}`, undefined, { confirmTitle: 'Kakek Hilang Perahu' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, id: t.orphan, freedBytes: bytes });
    expect(existsSync(join(t.w.dataDir, 'stories', t.orphan))).toBe(false);
    const grave = readFileSync(join(t.w.dataDir, 'audit', 'tenancy-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.action === 'yatim.hapus');
    expect(grave).toMatchObject({ action: 'yatim.hapus', targetId: t.orphan, by: t.w.admin.id, detail: { title: 'Kakek Hilang Perahu', ownerEmail: t.bina.user.email, bytes } });
    expect(typeof grave.atMs).toBe('number');
    expect((await t.w.req('DELETE', `/api/admin/projects/${t.orphan}`, undefined, { confirmTitle: 'Kakek Hilang Perahu' })).statusCode).toBe(404);
  });

  it('a project with a living owner can never be deleted here (409), whatever title is typed', async () => {
    const t = await seeded();
    const res = await t.w.req('DELETE', `/api/admin/projects/${t.live[0]}`, undefined, { confirmTitle: SECRET.title });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUKAN_YATIM');
    expect(res.body).not.toContain(SECRET.title);
    expect(existsSync(join(t.w.dataDir, 'stories', t.live[0]!))).toBe(true);
    // an invalid id never reaches the filesystem
    expect((await t.w.req('DELETE', '/api/admin/projects/..%2F..%2Fauth', undefined, { confirmTitle: 'x' })).statusCode).toBe(404);
    expect(existsSync(join(t.w.dataDir, 'auth.json'))).toBe(true);
  });
});

describe('T8 suspend / activate', () => {
  it('suspend signs the member out, keeps the projects, shows in the member list; activate lets them back; both are audited', async () => {
    const t = await seeded();
    const res = await t.w.req('POST', `/api/admin/users/${t.mira.user.id}/suspend`, undefined, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ id: t.mira.user.id, suspendedAt: expect.any(String) });
    expect((await t.w.req('GET', '/api/auth/me', t.mira.cookie)).statusCode).toBe(401);
    expect((await t.w.login(t.mira.user.email, 'member-pass-1')).res.statusCode).toBe(403);
    expect(existsSync(join(t.w.dataDir, 'stories', t.live[0]!, 'story.json'))).toBe(true);
    const members = (await t.w.req('GET', '/api/auth/members')).json().members;
    expect(members.find((m: { id: string }) => m.id === t.mira.user.id).suspendedAt).toEqual(expect.any(String));
    expect((await t.w.req('POST', `/api/admin/users/${t.mira.user.id}/activate`, undefined, {})).json().member.suspendedAt).toBeUndefined();
    expect((await t.w.login(t.mira.user.email, 'member-pass-1')).res.statusCode).toBe(200);
    const log = (await t.w.req('GET', '/api/admin/audit-log')).json().entries.map((e: { action: string }) => e.action);
    expect(log).toContain('anggota.tangguhkan');
    expect(log).toContain('anggota.aktifkan');
  });

  it('refuses suspending yourself (409 SELF), the last admin (409 LAST_ADMIN) and an unknown id (404)', async () => {
    const t = await seeded();
    const self = await t.w.req('POST', `/api/admin/users/${t.w.admin.id}/suspend`, undefined, {});
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF');
    expect((await t.w.req('POST', '/api/admin/users/u_nope/suspend', undefined, {})).statusCode).toBe(404);
    // an admin may suspend another admin; the suspended one is out at once (and the last ACTIVE admin rule lives in the store, tested there)
    t.w.auth.setAdmin(t.mira.user.id, true, t.w.admin.id);
    expect((await t.w.req('POST', `/api/admin/users/${t.w.admin.id}/suspend`, t.mira.cookie, {})).statusCode).toBe(200);
    expect((await t.w.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('T8 per-user limits and usage (numbers only)', () => {
  it('GET/PUT /api/admin/users/:id/limits: view, set, reset; validation 400; unknown 404; the change is audited without the numbers of anyone else', async () => {
    const t = await seeded();
    const url = `/api/admin/users/${t.mira.user.id}/limits`;
    const view = (await t.w.req('GET', url)).json();
    expect(view).toMatchObject({ userId: t.mira.user.id, email: t.mira.user.email, isAdmin: false, limits: {} });
    expect(view.effective.elevenChars).toMatchObject({ perDay: 2000, per30d: 5000, perRender: 2500 });
    expect(view.usage.elevenChars).toMatchObject({ day: 0, d30: 0 });
    const put = await t.w.req('PUT', url, undefined, { limits: { flowCredits: { perDay: 100, per30d: null }, openrouterUsd: { per30d: 5 } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().limits).toEqual({ flowCredits: { perDay: 100, per30d: null }, openrouterUsd: { per30d: 5 } });
    expect(put.json().effective.flowCredits).toMatchObject({ perDay: 100 });
    expect((await t.w.req('PUT', url, undefined, { limits: { elevenChars: { perDay: -1 } } })).statusCode).toBe(400);
    expect((await t.w.req('PUT', url, undefined, { limits: { kopi: { perDay: 1 } } })).statusCode).toBe(400);
    expect((await t.w.req('PUT', '/api/admin/users/u_gone/limits', undefined, { limits: {} })).statusCode).toBe(404);
    expect((await t.w.req('GET', '/api/admin/users/u_gone/limits')).statusCode).toBe(404);
    expect((await t.w.req('PUT', url, undefined, { limits: {} })).json().limits).toEqual({});
    const entries = (await t.w.req('GET', '/api/admin/audit-log')).json().entries;
    const changes = entries.filter((e: { action: string }) => e.action === 'batas.ubah');
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ by: t.w.admin.id, targetId: t.mira.user.id, targetEmail: t.mira.user.email, detail: { kinds: 'flowCredits,openrouterUsd' } });
  });

  it('the older PUT /api/quota/limits/:userId is audited too (same action)', async () => {
    const t = await seeded();
    await t.w.req('PUT', `/api/quota/limits/${t.mira.user.id}`, undefined, { limits: { genCalls: { perDay: 10 } } });
    const entries = (await t.w.req('GET', '/api/admin/audit-log')).json().entries;
    expect(entries.find((e: { action: string }) => e.action === 'batas.ubah')).toMatchObject({ targetId: t.mira.user.id, detail: { kinds: 'genCalls' } });
  });

  it('GET /api/admin/usage?days= lists EVERY live user (zeros included) with email and numbers, nothing about projects', async () => {
    const t = await seeded();
    const body = (await t.w.req('GET', '/api/admin/usage?days=7')).json();
    expect(body.days).toBe(7);
    expect(body.users.map((u: { email: string }) => u.email).sort()).toEqual([t.w.adminEmail, t.mira.user.email].sort());
    for (const user of body.users) expect(Object.keys(user).sort()).toEqual(['elevenChars', 'email', 'flowCredits', 'genCalls', 'llmTurns', 'openrouterUsd', 'userId']);
    expect((await t.w.req('GET', '/api/admin/usage?days=9999')).json().days).toBe(62);
    expect((await t.w.req('GET', '/api/admin/usage?days=abc')).json().days).toBe(7);
  });
});

describe('T8 audit log: who, what, when, target — never content', () => {
  it('records member removal and role change, newest first, limit clamped; an entry has a fixed set of keys', async () => {
    const t = await seeded();
    await t.w.req('PATCH', `/api/auth/members/${t.mira.user.id}`, undefined, { isAdmin: true });
    await t.w.req('POST', `/api/admin/projects/${t.orphan}/transfer`, undefined, { toUserId: t.w.admin.id });
    const all = (await t.w.req('GET', '/api/admin/audit-log')).json().entries as Array<Record<string, unknown>>;
    expect(all.map(e => e.action)).toEqual(['yatim.pindah', 'anggota.peran', 'anggota.hapus']);
    for (const e of all) { expect(Object.keys(e).sort().filter(k => !['detail', 'targetEmail'].includes(k))).toEqual(['action', 'atMs', 'by', 'byEmail', 'targetId']); expect(e.by).toBe(t.w.admin.id); }
    expect(all[2]).toMatchObject({ targetId: t.bina.user.id, targetEmail: t.bina.user.email });
    expect((await t.w.req('GET', '/api/admin/audit-log?limit=1')).json().entries).toHaveLength(1);
    expect((await t.w.req('GET', '/api/admin/audit-log?limit=0')).json().entries.length).toBeGreaterThan(0);
    const raw = JSON.stringify(all);
    for (const secret of [SECRET.prompt, SECRET.narration, SECRET.chat, SECRET.dub, 'member-pass-1', 'passwordHash']) expect(raw).not.toContain(secret);
    expect(statSync(join(t.w.dataDir, 'audit', 'tenancy-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('survives a damaged line and an empty file', async () => {
    const t = await seeded();
    expect((await t.w.req('GET', '/api/admin/audit-log')).json().entries.length).toBe(1); // only the removal of bina so far
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(t.w.dataDir, 'audit', 'tenancy-log.jsonl'), '{not json\n');
    expect((await t.w.req('GET', '/api/admin/audit-log')).json().entries.length).toBe(1);
  });
});

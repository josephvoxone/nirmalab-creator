import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { isStoryOwner } from '../src/publisher/owner.js';
import { PublisherTokenStore } from '../src/publisher/token-store.js';

afterEach(() => { vi.restoreAllMocks(); });

const MISSING = 'story_ffffffffffffffff';
const board = { title: 'Lentera Rahasia', audio: 'Audio: "{line}"', shots: [{ id: '00-a', silent: true, prompt: 'Wide shot of a valley.' }] };

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pubown-'));
  const auth = new UserAuthStore(dataDir);
  const joseph = await auth.createUser({ email: 'joseph@example.com', password: 'joseph-pass-1', isAdmin: true });
  const bina = await auth.createUser({ email: 'bina@example.com', password: 'bina-pass-123', isAdmin: true });
  const mira = await auth.createUser({ email: 'mira@example.com', password: 'mira-pass-123', isAdmin: false });
  const server = await buildApp({ dataDir, env: {}, stories: { reconcileMs: 0 } });
  const login = async (email: string, password: string) =>
    String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
  const cookies = { joseph: await login('joseph@example.com', 'joseph-pass-1'), bina: await login('bina@example.com', 'bina-pass-123'), mira: await login('mira@example.com', 'mira-pass-123') };
  const newStory = async (cookie: string): Promise<string> => {
    const res = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } });
    expect(res.statusCode).toBe(201);
    return res.json().story.id as string;
  };
  const patchRecord = (id: string, fn: (record: Record<string, unknown>) => Record<string, unknown>) => {
    const path = join(dataDir, 'stories', id, 'story.json');
    writeFileSync(path, JSON.stringify(fn(JSON.parse(readFileSync(path, 'utf8')))));
  };
  const done = (id: string) => patchRecord(id, r => ({ ...r, status: 'done' }));
  const preview = (cookie: string, id: string) => server.inject({ url: `/api/publish/preview/${id}`, headers: { cookie } });
  const publish = (cookie: string, id: string) =>
    server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie }, payload: { storyId: id, title: 'T', visibility: 'private' } });
  return { dataDir, server, joseph, bina, mira, cookies, newStory, patchRecord, done, preview, publish };
}

describe('T7.4 — preview/publish only for the owner of the project', () => {
  it('PoC: another admin (Bina) and a member (Mira) get 404 on Joseph\'s finished story, identical to a story that does not exist; Joseph gets through', async () => {
    const w = await world();
    const id = await w.newStory(w.cookies.joseph);
    w.done(id);
    const mine = await w.preview(w.cookies.joseph, id);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().title).toBe('Lentera Rahasia');
    expect((await w.publish(w.cookies.joseph, id)).json().error.code).toMatch(/NOT_CONNECTED|NOT_CONFIGURED/);

    const ghost = await w.preview(w.cookies.bina, MISSING);
    for (const who of ['bina', 'mira'] as const) {
      const res = await w.preview(w.cookies[who], id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(ghost.json()); // no oracle: same body as "no such story"
      expect(res.body).not.toContain('Lentera Rahasia');
    }
    const ghostPublish = await w.publish(w.cookies.bina, MISSING);
    const blocked = await w.publish(w.cookies.bina, id);
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json()).toEqual(ghostPublish.json());
  });

  it('a refused publish never reads any token (the token store is not touched) and never reaches the service', async () => {
    const w = await world();
    const id = await w.newStory(w.cookies.joseph);
    w.done(id);
    const get = vi.spyOn(PublisherTokenStore.prototype, 'get');
    const res = await w.publish(w.cookies.bina, id);
    expect(res.statusCode).toBe(404);
    expect(get).not.toHaveBeenCalled();
    await w.publish(w.cookies.joseph, id); // the owner does reach the token lookup
    expect(get).toHaveBeenCalled();
    expect(get.mock.calls.every(call => call[0] === w.joseph.id)).toBe(true);
  });

  it('a story another user created is theirs alone: Bina owns hers, Joseph (admin) cannot publish or preview it', async () => {
    const w = await world();
    const id = await w.newStory(w.cookies.bina);
    w.done(id);
    expect((await w.preview(w.cookies.bina, id)).statusCode).toBe(200);
    expect((await w.preview(w.cookies.joseph, id)).statusCode).toBe(404);
    expect((await w.publish(w.cookies.joseph, id)).statusCode).toBe(404);
    expect((await w.publish(w.cookies.bina, id)).json().error.code).toMatch(/NOT_CONNECTED|NOT_CONFIGURED/);
  });

  it('a story made before attribution (no createdBy) belongs to the main owner (oldest non-QA admin) only', async () => {
    const w = await world();
    const id = await w.newStory(w.cookies.joseph);
    w.patchRecord(id, ({ createdBy: _drop, ...rest }) => ({ ...rest, status: 'done' }));
    expect((await w.preview(w.cookies.joseph, id)).statusCode).toBe(200);
    expect((await w.preview(w.cookies.bina, id)).statusCode).toBe(404);
    expect((await w.preview(w.cookies.mira, id)).statusCode).toBe(404);
    expect((await w.publish(w.cookies.bina, id)).statusCode).toBe(404);
    expect((await w.publish(w.cookies.joseph, id)).json().error.code).toMatch(/NOT_CONNECTED|NOT_CONFIGURED/);
  });

  it('a story whose creator account no longer exists (orphan) is nobody\'s to publish — not even an admin\'s', async () => {
    const w = await world();
    const id = await w.newStory(w.cookies.joseph);
    // WAVE 4: ownership is the WORKSPACE, so an orphan means no workspace either (a record that still names a workspace is
    // still that workspace's, whoever `createdBy` says — that field is history now).
    w.patchRecord(id, r => ({ ...r, createdBy: 'u_deletedAccount1', workspaceId: undefined, status: 'done' }));
    for (const who of ['joseph', 'bina', 'mira'] as const) expect((await w.preview(w.cookies[who], id)).statusCode).toBe(404);
    for (const who of ['joseph', 'bina'] as const) expect((await w.publish(w.cookies[who], id)).statusCode).toBe(404);
    // T3 gate: a project that is not hers is a 404 for a member too (the project is checked before the role).
    expect((await w.publish(w.cookies.mira, id)).statusCode).toBe(404);
  });

  it('anonymous callers still get 401; a malformed id is the same 404 as a missing project (T3 gate: nothing about ids leaks)', async () => {
    const w = await world();
    expect((await w.server.inject({ url: `/api/publish/preview/${MISSING}` })).statusCode).toBe(401);
    expect((await w.preview(w.cookies.bina, 'nope')).statusCode).toBe(404);
  });

  it('the TENANCY_DEFAULT_OWNER_EMAIL account is the owner of attribution-less stories', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-pubown2-'));
    const auth = new UserAuthStore(dataDir);
    await auth.createUser({ email: 'joseph@example.com', password: 'joseph-pass-1', isAdmin: true });
    await auth.createUser({ email: 'bina@example.com', password: 'bina-pass-123', isAdmin: true });
    const server = await buildApp({ dataDir, env: { TENANCY_DEFAULT_OWNER_EMAIL: 'bina@example.com' }, stories: { reconcileMs: 0 } });
    const login = async (email: string, password: string) =>
      String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
    const joseph = await login('joseph@example.com', 'joseph-pass-1');
    const bina = await login('bina@example.com', 'bina-pass-123');
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: joseph }, payload: { storyboard: board } })).json().story.id as string;
    const path = join(dataDir, 'stories', id, 'story.json');
    // A project from before workspaces: neither an owner nor a workspace recorded, so the main owner inherits it.
    const { createdBy: _drop, workspaceId: _ws, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...rest, status: 'done' }));
    expect((await server.inject({ url: `/api/publish/preview/${id}`, headers: { cookie: bina } })).statusCode).toBe(200);
    expect((await server.inject({ url: `/api/publish/preview/${id}`, headers: { cookie: joseph } })).statusCode).toBe(404);
  });
});

describe('isStoryOwner (the small replaceable decision)', () => {
  it('createdBy decides; no createdBy => the main owner; unknown story => no', () => {
    expect(isStoryOwner({ createdBy: 'u_a' }, 'u_a', 'u_main')).toBe(true);
    expect(isStoryOwner({ createdBy: 'u_a' }, 'u_main', 'u_main')).toBe(false); // the main owner is not an all-seeing admin
    expect(isStoryOwner({}, 'u_main', 'u_main')).toBe(true);
    expect(isStoryOwner({}, 'u_a', 'u_main')).toBe(false);
    expect(isStoryOwner({}, 'u_a', undefined)).toBe(false);
    expect(isStoryOwner(undefined, 'u_main', 'u_main')).toBe(false);
  });
});

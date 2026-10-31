/**
 * WAVE 4 / access — ownership moved from the PERSON to the WORKSPACE.
 *
 * Roles inside a workspace (WAVE4-BRIEF): owner and editor change projects, viewer only reads (403 VIEWER_READ_ONLY on every
 * write), and anyone else — platform admin included — gets the same 404 as for a project that does not exist.
 * The project belongs to the workspace, so removing a member takes their access away on the next request while the project
 * stays exactly where it is.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpTokenStore } from '../src/mcp/tokens.js';
import { bibleBoard } from './bible-board.js';
import { makePng } from './media-helpers.js';
import {
  makeWorkspaceAccess, personalWorkspaceId, removeMembership, setMembership, workspaceRole, createWorkspaceRecord
} from '../src/tenancy/workspace-role.js';

const PASS = 'workspace-pass-1';
type Actor = { id: string; email: string; cookie: string };

async function login(server: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASS } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-access-'));
  const emailA = 'owner@x.io';
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: emailA, OPENCREATOR_ADMIN_PASSWORD: PASS },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(64, 1)); },
      generateText: async () => JSON.stringify({ title: 'Draf', audio: 'Audio: "{line}"', shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley.' }] })
    },
    providers: { workerMs: 0, fetch: (async () => { throw new Error('no network in tests'); }) as typeof fetch },
    dub: { resume: false, fetch: (async () => { throw new Error('no ElevenLabs in tests'); }) as typeof fetch },
    media: { cleanupMs: 0 }
  });
  const users = new UserAuthStore(dataDir);
  const mk = async (label: string, isAdmin: boolean): Promise<Actor> => {
    const email = `${label}@x.io`;
    const user = await users.createUser({ email, password: PASS, isAdmin });
    return { id: user.id, email, cookie: await login(server, email) };
  };
  const a: Actor = { id: users.findUserByEmail(emailA)!.id, email: emailA, cookie: await login(server, emailA) };
  const e = await mk('editor', false);
  const v = await mk('viewer', false);
  const n = await mk('stranger', true); // platform admin, NOT a member: must still get 404
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined });
  return { dataDir, server, users, a, e, v, n, flow, service };
}

const S = (p: { id: string }, rest = '') => `/api/stories/${p.id}${rest}`;

describe('workspace role adaptor', () => {
  it('personal workspace is owned implicitly, a membership grants a role, removal takes it away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ws-role-'));
    const owner = 'u_owner1';
    expect(await workspaceRole(dir, owner, personalWorkspaceId(owner))).toBe('owner');
    expect(await workspaceRole(dir, 'u_other', personalWorkspaceId(owner))).toBeUndefined();
    await setMembership(dir, { workspaceId: personalWorkspaceId(owner), userId: 'u_other', role: 'viewer' });
    expect(await workspaceRole(dir, 'u_other', personalWorkspaceId(owner))).toBe('viewer');
    await setMembership(dir, { workspaceId: personalWorkspaceId(owner), userId: 'u_other', role: 'editor' });
    expect(await workspaceRole(dir, 'u_other', personalWorkspaceId(owner))).toBe('editor');
    await removeMembership(dir, { workspaceId: personalWorkspaceId(owner), userId: 'u_other' });
    expect(await workspaceRole(dir, 'u_other', personalWorkspaceId(owner))).toBeUndefined();
    const extra = await createWorkspaceRecord(dir, { name: 'Tim Lentera', ownerId: owner });
    // Wave 4 merged the temporary adaptor into the real store: creating a workspace makes you its owner at once
    // (that is what POST /api/workspaces does), and a personal workspace is named after its person, not a constant.
    expect(await workspaceRole(dir, owner, extra.id)).toBe('owner');
    const listed = await makeWorkspaceAccess(dir).workspacesFor(owner);
    expect(listed.find(w => w.id === extra.id)).toMatchObject({ name: 'Tim Lentera', role: 'owner', personal: false });
    expect(listed.find(w => w.personal)).toMatchObject({ id: personalWorkspaceId(owner), role: 'owner' });
  });
});

describe('workspace access at the HTTP gate', () => {
  it('viewer reads the project and its media; every write answers 403 VIEWER_READ_ONLY and nothing changes', async () => {
    const w = await world();
    try {
      const created = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard() } });
      expect(created.statusCode, created.body).toBe(201);
      const project = created.json().story as { id: string };
      expect(project.id).toBeTruthy();
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.v.id, role: 'viewer' });

      // Reads: the project, its board, its media and its history.
      for (const url of [S(project), S(project, '/dub'), S(project, '/assistant')]) {
        const res = await w.server.inject({ url, headers: { cookie: w.v.cookie } });
        expect(res.statusCode, url).toBe(200);
      }

      const writes: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }> = [
        { method: 'PUT', url: S(project), payload: { storyboard: { ...bibleBoard(), title: 'Ditimpa viewer' } } },
        { method: 'POST', url: S(project, '/assemble'), payload: {} },
        { method: 'POST', url: S(project, '/render'), payload: {} },
        { method: 'POST', url: S(project, '/prepare'), payload: {} },
        { method: 'POST', url: S(project, '/shots/01-laras/frame'), payload: {} },
        { method: 'POST', url: S(project, '/dub/render'), payload: { scope: { kind: 'all' } } },
        { method: 'POST', url: S(project, '/dub/plan'), payload: { scope: { kind: 'all' } } },
        { method: 'PUT', url: S(project, '/dub/settings'), payload: { voiceId: 'voice_x' } },
        { method: 'POST', url: S(project, '/shots/01-laras/approve-audit'), payload: {} },
        { method: 'POST', url: S(project, '/motion-check'), payload: {} },
        { method: 'POST', url: '/api/publish/youtube/publish', payload: { storyId: project.id, title: 'x' } }
      ];
      for (const req of writes) {
        const res = await w.server.inject({ method: req.method, url: req.url, headers: { cookie: w.v.cookie }, ...(req.payload === undefined ? {} : { payload: req.payload as object }) });
        expect(res.statusCode, `${req.method} ${req.url}: ${res.body}`).toBe(403);
        expect(res.json().error.code, `${req.method} ${req.url}`).toBe('VIEWER_READ_ONLY');
      }
      // Raw-body writes are refused before the parser: the 10 MB / 25 MB bodies are never read.
      const up = await w.server.inject({ method: 'POST', url: S(project, '/uploads'), headers: { cookie: w.v.cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(2048, 1) });
      expect(up.statusCode, up.body).toBe(403);
      const music = await w.server.inject({ method: 'POST', url: S(project, '/music'), headers: { cookie: w.v.cookie, 'content-type': 'audio/mpeg' }, payload: Buffer.alloc(2048, 1) });
      expect(music.statusCode, music.body).toBe(403);
      // Nothing moved: the title is the owner's.
      expect((await w.server.inject({ url: S(project), headers: { cookie: w.a.cookie } })).json().story.title).toBe(bibleBoard().title);
    } finally { await w.server.close(); }
  }, 60_000);

  it('editor changes the project like the owner; a non-member platform admin still gets the same 404', async () => {
    const w = await world();
    try {
      const created = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard() } });
      const project = created.json().story as { id: string };
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.e.id, role: 'editor' });
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.v.id, role: 'viewer' });

      const edit = await w.server.inject({ method: 'PUT', url: S(project), headers: { cookie: w.e.cookie }, payload: { storyboard: { ...bibleBoard(), title: 'Disunting editor' } } });
      expect(edit.statusCode, edit.body).toBe(200);
      expect((await w.server.inject({ url: S(project), headers: { cookie: w.a.cookie } })).json().story.title).toBe('Disunting editor');

      // The viewer may read; the platform admin is not a member and must not even see the title.
      expect((await w.server.inject({ url: S(project), headers: { cookie: w.v.cookie } })).statusCode).toBe(200);
      const admin = await w.server.inject({ url: S(project), headers: { cookie: w.n.cookie } });
      expect(admin.statusCode, admin.body).toBe(404);
      expect(admin.body).not.toContain('Disunting editor');
      // An editor is not a member of A's OTHER workspaces.
      const other = await createWorkspaceRecord(w.dataDir, { name: 'Tim Lain', ownerId: w.a.id });
      await setMembership(w.dataDir, { workspaceId: other.id, userId: w.a.id, role: 'owner' });
      const foreign = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard(), workspaceId: other.id } });
      expect(foreign.statusCode, foreign.body).toBe(201);
      const foreignId = foreign.json().story.id as string;
      expect((await w.server.inject({ url: S({ id: foreignId }), headers: { cookie: w.e.cookie } })).statusCode).toBe(404);
    } finally { await w.server.close(); }
  }, 60_000);
});

describe('MCP acts as the token owner in the workspaces they follow', () => {
  it('an editor token reads and changes a project of the workspace; a viewer token reads it but every action is refused', async () => {
    const w = await world();
    let base = '';
    try {
      const created = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard() } });
      const project = created.json().story as { id: string };
      // MCP tokens are only issued to accounts that may hold one (an admin); the workspace role still decides the project.
      const editorUser = await w.users.createUser({ email: 'mcp-editor@x.io', password: PASS, isAdmin: true });
      const viewerUser = await w.users.createUser({ email: 'mcp-viewer@x.io', password: PASS, isAdmin: true });
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: editorUser.id, role: 'editor' });
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: viewerUser.id, role: 'viewer' });
      await w.server.listen({ port: 0, host: '127.0.0.1' });
      base = `http://127.0.0.1:${(w.server.server.address() as AddressInfo).port}`;
      const tokens = new McpTokenStore(w.dataDir, w.users);
      const connect = async (userId: string) => {
        const token = (await tokens.create(userId, 'ws')).token;
        const client = new Client({ name: 'ws-access', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        return client;
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
        return { isError: res.isError === true, text: res.content[0]!.text };
      };

      const editor = await connect(editorUser.id);
      const listed = await call(editor, 'list_projects', {});
      expect(listed.text).toContain(project.id); // the editor follows the workspace: the project is theirs to see
      expect((await call(editor, 'get_project', { project_id: project.id })).isError).toBe(false);
      // A change lands (the editor may edit a project they did not create).
      const edited = await call(editor, 'move_shot', { project_id: project.id, shot: 1, after: 2 });
      expect(edited.isError, edited.text).toBe(false);
      await editor.close();

      const viewer = await connect(viewerUser.id);
      const viewerRead = await call(viewer, 'get_project', { project_id: project.id });
      expect(viewerRead.isError, viewerRead.text).toBe(false); // reading is allowed
      const refused = await call(viewer, 'move_shot', { project_id: project.id, shot: 1, after: 2 });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('penonton');
      await viewer.close();

      // A platform admin with a token but no membership sees nothing.
      const stranger = await connect(w.n.id);
      expect((await call(stranger, 'list_projects', {})).text).not.toContain(project.id);
      expect((await call(stranger, 'get_project', { project_id: project.id })).isError).toBe(true);
      await stranger.close();
    } finally { await w.server.close(); }
  }, 60_000);
});

describe('projects belong to workspaces', () => {
  it('GET /api/stories lists the projects of every followed workspace with the workspace name; ?workspace= scopes; a stranger workspace is 404', async () => {
    const w = await world();
    try {
      const personal = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard() } });
      expect(personal.statusCode, personal.body).toBe(201);
      const team = await createWorkspaceRecord(w.dataDir, { name: 'Tim Lentera', ownerId: w.a.id });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.a.id, role: 'owner' });
      const inTeam = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard(), workspaceId: team.id } });
      expect(inTeam.statusCode, inTeam.body).toBe(201);
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.e.id, role: 'editor' });

      const all = (await w.server.inject({ url: '/api/stories', headers: { cookie: w.a.cookie } })).json().stories as Array<{ id: string; workspace: { id: string; name: string; role: string } }>;
      expect(all.map(s => s.id).sort()).toEqual([personal.json().story.id, inTeam.json().story.id].sort());
      // A personal workspace is named after its person (`Ruang kerja <nama depan>`), not a constant (wave 4 merge).
      expect(all.find(s => s.id === personal.json().story.id)!.workspace).toMatchObject({ id: personalWorkspaceId(w.a.id), role: 'owner' });
      expect(all.find(s => s.id === inTeam.json().story.id)!.workspace.name).toBe('Tim Lentera');
      expect(all.find(s => s.id === inTeam.json().story.id)!.workspace.role).toBe('owner');

      const scoped = (await w.server.inject({ url: `/api/stories?workspace=${team.id}`, headers: { cookie: w.e.cookie } })).json().stories as Array<{ id: string }>;
      expect(scoped.map(s => s.id)).toEqual([inTeam.json().story.id]);

      const notMine = await w.server.inject({ url: `/api/stories?workspace=${personalWorkspaceId(w.a.id)}`, headers: { cookie: w.e.cookie } });
      expect(notMine.statusCode, notMine.body).toBe(404);
      // The editor's own list: the team project only (their personal workspace is empty), never A's personal one.
      const editorList = (await w.server.inject({ url: '/api/stories', headers: { cookie: w.e.cookie } })).json().stories as Array<{ id: string }>;
      expect(editorList.map(s => s.id)).toEqual([inTeam.json().story.id]);
    } finally { await w.server.close(); }
  }, 60_000);

  it('POST /api/stories needs a workspace the caller may edit: viewer 403, non-member 404, absent = the caller\'s personal workspace', async () => {
    const w = await world();
    try {
      const team = await createWorkspaceRecord(w.dataDir, { name: 'Tim Lentera', ownerId: w.a.id });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.a.id, role: 'owner' });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.v.id, role: 'viewer' });

      const denied = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.v.cookie }, payload: { storyboard: bibleBoard(), workspaceId: team.id } });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json().error.code).toBe('VIEWER_READ_ONLY');

      const stranger = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.n.cookie }, payload: { storyboard: bibleBoard(), workspaceId: team.id } });
      expect(stranger.statusCode, stranger.body).toBe(404);
      expect(stranger.body).not.toContain('Tim Lentera');

      // No workspaceId: the caller's personal workspace, recorded on the project so the next request resolves it.
      const own = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.e.cookie }, payload: { storyboard: bibleBoard() } });
      expect(own.statusCode, own.body).toBe(201);
      expect(own.json().story.workspaceId).toBe(personalWorkspaceId(w.e.id));
      expect((await w.server.inject({ url: S(own.json().story), headers: { cookie: w.a.cookie } })).statusCode).toBe(404);
    } finally { await w.server.close(); }
  }, 60_000);

  it('generated files belong to the workspace: every member reads them, a non-member gets 404, and output lands in that workspace', async () => {
    const w = await world();
    try {
      const team = await createWorkspaceRecord(w.dataDir, { name: 'Tim Lentera', ownerId: w.a.id });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.a.id, role: 'owner' });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.e.id, role: 'editor' });
      await setMembership(w.dataDir, { workspaceId: team.id, userId: w.v.id, role: 'viewer' });
      // A file of the team (written by the route into free-generate/workspaces/<id>/tts, here placed directly).
      const dir = join(w.dataDir, 'free-generate', 'workspaces', team.id, 'tts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'tts-1-2.mp3'), Buffer.from('MP3:tim'));
      const url = '/api/generate/files/tts/tts-1-2.mp3';
      for (const who of [w.a, w.e, w.v]) {
        const res = await w.server.inject({ url, headers: { cookie: who.cookie } });
        expect(res.statusCode, `${who.email}: ${res.body}`).toBe(200);
      }
      expect((await w.server.inject({ url, headers: { cookie: w.n.cookie } })).statusCode).toBe(404);
      // A viewer cannot write into the workspace; a member of another workspace sees nothing of this one.
      const up = await w.server.inject({ method: 'POST', url: '/api/generate/image', headers: { cookie: w.v.cookie }, payload: { prompt: 'x', workspaceId: team.id } });
      expect(up.statusCode, up.body).toBe(403);
      expect(up.json().error.code).toBe('VIEWER_READ_ONLY');
      const foreign = await w.server.inject({ method: 'POST', url: '/api/generate/image', headers: { cookie: w.n.cookie }, payload: { prompt: 'x', workspaceId: team.id } });
      expect(foreign.statusCode, foreign.body).toBe(404);
    } finally { await w.server.close(); }
  }, 60_000);

  it('removing a member takes the access away on the next request (404) and the project stays in the workspace', async () => {
    const w = await world();
    try {
      const created = await w.server.inject({ method: 'POST', url: '/api/stories', headers: { cookie: w.a.cookie }, payload: { storyboard: bibleBoard() } });
      const project = created.json().story as { id: string; workspaceId: string };
      await setMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.e.id, role: 'editor' });
      expect((await w.server.inject({ url: S(project), headers: { cookie: w.e.cookie } })).statusCode).toBe(200);

      await removeMembership(w.dataDir, { workspaceId: personalWorkspaceId(w.a.id), userId: w.e.id });
      expect((await w.server.inject({ url: S(project), headers: { cookie: w.e.cookie } })).statusCode).toBe(404);
      // Still in the workspace, still the owner's, untouched.
      const still = await w.server.inject({ url: S(project), headers: { cookie: w.a.cookie } });
      expect(still.statusCode).toBe(200);
      expect(still.json().story.workspaceId).toBe(personalWorkspaceId(w.a.id));
      expect((await makeWorkspaceAccess(w.dataDir).roleOf(w.e.id, personalWorkspaceId(w.a.id)))).toBeUndefined();
    } finally { await w.server.close(); }
  }, 60_000);
});

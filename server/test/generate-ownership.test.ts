import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFreeGenerateRoutes } from '../src/generate/routes.js';
import { GenerateRouter } from '../src/generate/pool.js';
import { AccountPoolStore } from '../src/generate/accounts.js';
import { writeFile } from 'node:fs/promises';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

/** A = oldest admin (main owner), B = second admin, M = member. */
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'gen-own-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'gen-own-auth-')));
  const a = await auth.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
  const b = await auth.createUser({ email: 'b@x.io', password: 'admin-pass-2', isAdmin: true });
  const m = await auth.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
  const clipDirs: string[] = [];
  const router = new GenerateRouter();
  router.register({
    name: 'fake',
    async generate(_request, ctx) {
      clipDirs.push(ctx.outDir);
      mkdirSync(ctx.outDir, { recursive: true });
      const filePath = join(ctx.outDir, 'fake-1-2.mp4');
      await writeFile(filePath, Buffer.alloc(2048, 5));
      return { ok: true, filePath, provider: 'fake' };
    }
  });
  server = Fastify();
  await registerFreeGenerateRoutes(server, {
    userAuthStore: auth, dataDir, router, env: {}, pools: new AccountPoolStore(join(dataDir, 'free-generate', 'pools')),
    ttsRun: async text => Buffer.from(`audio:${text}`.padEnd(2048, '.')),
    fetch: async () => new Response(Buffer.alloc(4096, 9), { status: 200 })
  });
  await server.ready();
  const cookie = (u: { id: string }) => ({ cookie: `oc_session=${auth.createSession(u.id).token}` });
  const A = { ...a, ...cookie(a) }, B = { ...b, ...cookie(b) }, M = { ...m, ...cookie(m) };
  const get = (url: string, who?: { cookie: string }) => server!.inject({ url, ...(who ? { headers: who } : {}) });
  const post = (url: string, who: { cookie: string }, payload: object) => server!.inject({ method: 'POST', url, headers: who, payload });
  return { dataDir, A, B, M, get, post, clipDirs };
}

describe('T7: generated files belong to the user who made them', () => {
  it('a TTS file is readable by its owner only; other admins and members get 404, no session 401', async () => {
    const t = await setup();
    const made = await t.post('/api/generate/tts', t.B, { text: 'halo rahasia B' });
    expect(made.statusCode).toBe(200);
    const url = made.json().url as string;
    expect(url).toMatch(/^\/api\/generate\/files\/tts\/tts-\d+-\d+\.mp3$/);
    const mine = await t.get(url, t.B);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('audio/mpeg');
    expect(mine.rawPayload.toString()).toContain('audio:halo rahasia B');
    const missing = await t.get('/api/generate/files/tts/tts-0-0.mp3', t.A);
    for (const who of [t.A, t.M]) {
      const res = await t.get(url, who);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect((await t.get(url)).statusCode).toBe(401);
  });

  it('an image of A is A\'s: B cannot fetch it even knowing the exact name', async () => {
    const t = await setup();
    const made = await t.post('/api/generate/image', t.A, { prompt: 'kucing' });
    expect(made.statusCode).toBe(200);
    const url = made.json().url as string;
    expect((await t.get(url, t.A)).statusCode).toBe(200);
    expect((await t.get(url, t.B)).statusCode).toBe(404);
    expect((await t.get(url, t.M)).statusCode).toBe(404);
  });

  it('two users with the same file name each read their own bytes (per-user directories)', async () => {
    const t = await setup();
    for (const [who, byte] of [[t.A, 1], [t.B, 2]] as const) {
      const dir = join(t.dataDir, 'free-generate', 'users', who.id, 'tts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'tts-1-2.mp3'), Buffer.alloc(2048, byte));
    }
    expect((await t.get('/api/generate/files/tts/tts-1-2.mp3', t.A)).rawPayload[0]).toBe(1);
    expect((await t.get('/api/generate/files/tts/tts-1-2.mp3', t.B)).rawPayload[0]).toBe(2);
    expect((await t.get('/api/generate/files/tts/tts-1-2.mp3', t.M)).statusCode).toBe(404);
  });

  it('a file written before per-user storage (legacy folder) is readable by the main owner only', async () => {
    const t = await setup();
    mkdirSync(join(t.dataDir, 'free-generate', 'tts'), { recursive: true });
    writeFileSync(join(t.dataDir, 'free-generate', 'tts', 'tts-9-9.mp3'), Buffer.alloc(2048, 4));
    expect((await t.get('/api/generate/files/tts/tts-9-9.mp3', t.A)).statusCode).toBe(200);
    expect((await t.get('/api/generate/files/tts/tts-9-9.mp3', t.B)).statusCode).toBe(404);
    expect((await t.get('/api/generate/files/tts/tts-9-9.mp3', t.M)).statusCode).toBe(404);
  });

  it('clips are rendered into the folder of the acting workspace (the caller\'s personal one by default)', async () => {
    const t = await setup();
    expect((await t.post('/api/generate/clip', t.B, { prompt: 'ombak' })).statusCode).toBe(200);
    // WAVE 4: output belongs to a workspace, not to a person: the personal workspace of B is where B's Studio output lives.
    const dir = join(t.dataDir, 'free-generate', 'workspaces', `ws_personal_${t.B.id}`, 'clips');
    expect(t.clipDirs).toEqual([dir]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('never leaves the generated folders (traversal, other kinds, the users folder itself)', async () => {
    const t = await setup();
    for (const url of ['/api/generate/files/tts/..%2F..%2Fsecret.json', '/api/generate/files/users/x.mp3', '/api/generate/files/tts/..%2Fusers%2Fx%2Ftts%2Fa.mp3', '/api/generate/files/clips/fake-1-2.mp4']) {
      expect((await t.get(url, t.A)).statusCode, url).toBe(404);
    }
  });
});

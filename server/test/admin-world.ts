import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';

const ADMIN_PASSWORD = 'admin-pass-1';
let counter = 0;
export const storyId = (n = ++counter) => `story_${n.toString(16).padStart(16, '0')}`;

/** Strings that must never reach an admin looking at somebody else's LIVE project (they sit in files the admin routes must not open). */
export const SECRET = { title: 'Judul Rahasia Mira', prompt: 'PROMPT-RAHASIA-KUCING-BIRU', narration: 'NARASI-RAHASIA-SUNGAI', chat: 'CHAT-RAHASIA-ASISTEN', dub: 'DUB-RAHASIA-SUARA' };

export type StoryFixture = { id: string; ownerId?: string; title?: string; status?: string; extraBytes?: number; createdAtMs?: number; updatedAtMs?: number };

/** A project on disk as the service writes it: story.json (metadata) + the private files (storyboard/assistant/dub) + a media file. */
export function writeStory(dataDir: string, f: StoryFixture): string {
  const dir = join(dataDir, 'stories', f.id);
  mkdirSync(dir, { recursive: true });
  const record = {
    id: f.id, rev: 3, title: f.title ?? SECRET.title, status: f.status ?? 'draft', createdAtMs: f.createdAtMs ?? 1_700_000_000_000, updatedAtMs: f.updatedAtMs ?? 1_700_000_500_000,
    shots: [{ id: '00-a', status: 'idle', prompt: SECRET.prompt, narration: SECRET.narration }], events: [{ atMs: 1, message: SECRET.chat }],
    ...(f.ownerId ? { createdBy: f.ownerId } : {})
  };
  writeFileSync(join(dir, 'story.json'), JSON.stringify(record, null, 1));
  writeFileSync(join(dir, 'storyboard.json'), JSON.stringify({ title: f.title ?? SECRET.title, shots: [{ id: '00-a', prompt: SECRET.prompt, narration: SECRET.narration }] }));
  writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ turns: [{ role: 'user', text: SECRET.chat }] }));
  writeFileSync(join(dir, 'dub.json'), JSON.stringify({ shots: { '00-a': { text: SECRET.dub } } }));
  writeFileSync(join(dir, '00-a.mp4'), Buffer.alloc(f.extraBytes ?? 1000, 7));
  return dir;
}

export async function adminWorld(extra: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-adm-'));
  // A fresh admin email per world: the login rate limit is a process-wide table, many worlds would trip it (429).
  const worldNo = ++counter;
  const adminEmail = `admin${worldNo}@x.io`;
  const ENV = { OPENCREATOR_ADMIN_EMAIL: adminEmail, OPENCREATOR_ADMIN_PASSWORD: ADMIN_PASSWORD };
  const server: FastifyInstance = await buildApp({
    dataDir, env: ENV, logger: false,
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 }, ...extra
  });
  const login = async (email: string, password: string) => {
    const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return { res, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '' };
  };
  const auth = new UserAuthStore(dataDir);
  const admin = auth.findUserByEmail(adminEmail)!;
  const adminCookie = (await login(adminEmail, ADMIN_PASSWORD)).cookie;
  const addUser = async (email: string, isAdmin = false) => {
    // unique per world (rate limit is keyed on ip+email and shared by the whole process); tests read `user.email`
    const unique = email.replace('@', `+${worldNo}@`);
    const user = await auth.createUser({ email: unique, password: 'member-pass-1', isAdmin });
    return { user, cookie: (await login(unique, 'member-pass-1')).cookie };
  };
  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string | undefined = adminCookie, payload?: unknown) =>
    server.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as object }) });
  return { server, dataDir, auth, admin, adminEmail, adminCookie, addUser, login, req };
}

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';

// Separate file: the login limiter is module-level (10 logins per window per process).
const board = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
};

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-attr-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      generateText: async () => JSON.stringify(board)
    }
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { server, cookie, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
}

describe('story attribution', () => {
  it('stories created over HTTP (POST and draft) record the session user, and their Flow jobs carry it', async () => {
    const { server, cookie, dataDir, flow } = await setup();
    const adminId = JSON.parse(readFileSync(join(dataDir, 'auth.json'), 'utf8')).users[0].id as string;
    const createdRes = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } });
    expect(createdRes.statusCode, createdRes.body).toBe(201);
    const created = createdRes.json().story;
    expect(created.createdBy).toBe(adminId);
    const drafted = await server.inject({ method: 'POST', url: '/api/stories/draft', headers: { cookie }, payload: { premise: 'kucing hilang', shots: 2 } });
    expect(drafted.statusCode).toBe(201);
    expect(drafted.json().story.createdBy).toBe(adminId);
    await server.inject({ method: 'POST', url: `/api/stories/${created.id}/render`, headers: { cookie }, payload: {} });
    const jobs = await flow.listJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every(j => j.createdBy === adminId)).toBe(true);
  });
});

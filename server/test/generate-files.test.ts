import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { generatedFileUrl } from '../src/generate/routes.js';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-gf-'));
  mkdirSync(join(dataDir, 'free-generate', 'tts'), { recursive: true });
  mkdirSync(join(dataDir, 'free-generate', 'images'), { recursive: true });
  writeFileSync(join(dataDir, 'free-generate', 'tts', 'tts-1-2.mp3'), Buffer.alloc(2048, 1));
  writeFileSync(join(dataDir, 'free-generate', 'images', 'pollinations-1-2.jpg'), Buffer.alloc(2048, 2));
  writeFileSync(join(dataDir, 'secret.json'), '{"x":1}');
  const server = await buildApp({ dataDir, env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' }, stories: { reconcileMs: 0 } });
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  return { server, cookie: String(login.headers['set-cookie']).split(';')[0]!, dataDir };
}

describe('generated files', () => {
  it('maps a generated file path to a browser URL', () => {
    expect(generatedFileUrl('/data/free-generate/tts/tts-1-2.mp3')).toBe('/api/generate/files/tts/tts-1-2.mp3');
    expect(generatedFileUrl('/data/free-generate/images/pollinations-1-2.jpg')).toBe('/api/generate/files/images/pollinations-1-2.jpg');
    expect(generatedFileUrl('/etc/passwd')).toBeUndefined();
  });

  it('serves audio and images to members only, with the right type', async () => {
    const { server, cookie } = await setup();
    expect((await server.inject('/api/generate/files/tts/tts-1-2.mp3')).statusCode).toBe(401);
    const audio = await server.inject({ url: '/api/generate/files/tts/tts-1-2.mp3', headers: { cookie } });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.rawPayload.length).toBe(2048);
    const image = await server.inject({ url: '/api/generate/files/images/pollinations-1-2.jpg', headers: { cookie } });
    expect(image.headers['content-type']).toBe('image/jpeg');
  });

  it('never leaves the generated folders', async () => {
    const { server, cookie } = await setup();
    for (const url of ['/api/generate/files/tts/..%2F..%2Fsecret.json', '/api/generate/files/other/x.mp3', '/api/generate/files/tts/missing.mp3', '/api/generate/files/tts/.hidden.mp3']) {
      expect((await server.inject({ url, headers: { cookie } })).statusCode, url).toBe(404);
    }
  });
});

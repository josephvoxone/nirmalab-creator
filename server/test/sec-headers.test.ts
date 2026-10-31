/** Basic response headers on every kind of response: API, SPA fallback, static assets, 404, errors. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

let server: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'nc-sec-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  server = await buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'nc-sec-hdr-')), webDist,
    env: { OPENCREATOR_ADMIN_EMAIL: 'hdr@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
});
afterAll(async () => { await server?.close(); });

describe('basic security headers', () => {
  for (const [name, url] of [['API', '/api/health'], ['SPA page', '/cerita'], ['static asset', '/assets/app.js'], ['API 401', '/api/auth/me'], ['API 404', '/api/nope']] as const) {
    it(`${name} carries nosniff, no framing (XFO + CSP frame-ancestors), referrer policy, base-uri/object-src locked`, async () => {
      const res = await server.inject(url);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("object-src 'none'");
    });
  }

  it('the CSP restricts nothing the app loads (no script-src/style-src/img-src/connect-src/default-src), so the SPA, media and embeds keep working', async () => {
    const csp = String((await server.inject('/')).headers['content-security-policy']);
    for (const directive of ['default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'connect-src', 'frame-src', 'font-src', 'form-action']) expect(csp).not.toContain(directive);
  });
});

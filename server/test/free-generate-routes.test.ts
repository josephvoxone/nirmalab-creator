import { describe, expect, it } from 'vitest';
import { generateErrorStatus } from '../src/generate/routes.js';

describe('generateErrorStatus', () => {
  it('tidak pernah 502 agar JSON lolos Cloudflare', () => {
    expect(generateErrorStatus('INVALID_INPUT')).toBe(400);
    expect(generateErrorStatus('NEEDS_KEY')).toBe(402);
    expect(generateErrorStatus('UNAUTHORIZED')).toBe(401);
    for (const code of ['GENERATE_FAILED', 'ALL_FAILED', 'TIMEOUT', 'NO_ACCOUNT', 'TTS_FAILED', 'UNKNOWN']) {
      expect(generateErrorStatus(code)).toBe(503);
    }
  });
});

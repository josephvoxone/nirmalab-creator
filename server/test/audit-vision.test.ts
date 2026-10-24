import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_GATE, MAX_AUDIT_IMAGES, AuditParseError, auditBand, auditPrompt, auditShot, clearsGate, parseAuditReply, redFlags
} from '../src/audit/vision.js';

const png = (seed: number) => {
  const b = Buffer.alloc(2048, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(768, 16);
  b.writeUInt32BE(1376, 20);
  return b;
};

function imagesDir(count: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'nc-audit-img-'));
  return Array.from({ length: count }, (_, i) => {
    const file = join(dir, `frame-${i}.png`);
    writeFileSync(file, png(i + 1));
    return file;
  });
}

const reply = (value: unknown) => JSON.stringify(value);

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(content: string, cost?: number) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: cost === undefined ? {} : { cost } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const valid = {
  score: 78,
  dimensions: { sceneMatch: 80, actionMatch: 75, moodMatch: 85, composition: 72 },
  issues: [],
  reasoning: 'The gate and the cat are both in frame.',
  repair: ''
};

describe('parseAuditReply', () => {
  it('parses a valid reply with all four dimensions', () => {
    const got = parseAuditReply(reply(valid));
    expect(got).toMatchObject({ score: 78, reasoning: valid.reasoning });
    expect(got.dimensions).toEqual(valid.dimensions);
    expect(got.issues).toEqual([]);
    expect(got.repair).toBe('');
  });

  it('reads JSON inside a code fence or surrounding prose', () => {
    expect(parseAuditReply('```json\n' + reply(valid) + '\n```').score).toBe(78);
    expect(parseAuditReply('Here is my audit: ' + reply(valid) + ' — done.').score).toBe(78);
  });

  it('missing dimensions fall back to the score', () => {
    const got = parseAuditReply(reply({ score: 64, issues: ['the gate is missing'] }));
    expect(got.dimensions).toEqual({ sceneMatch: 64, actionMatch: 64, moodMatch: 64, composition: 64 });
  });

  it('missing score falls back to the dimension average', () => {
    const got = parseAuditReply(reply({ dimensions: { sceneMatch: 60, actionMatch: 80, moodMatch: 70, composition: 50 } }));
    expect(got.score).toBe(65);
  });

  it('a missing repair becomes an instruction that names every issue', () => {
    const got = parseAuditReply(reply({ score: 55, issues: ['the wooden gate is missing', 'the cat is cropped at the edge'] }));
    expect(got.repair).toContain('the wooden gate is missing');
    expect(got.repair).toContain('the cat is cropped at the edge');
    expect(got.repair).toMatch(/fix/i);
  });

  it('clamps out-of-range numbers instead of trusting them', () => {
    const got = parseAuditReply(reply({ score: 140, dimensions: { sceneMatch: -20, actionMatch: 250, moodMatch: 90, composition: '70' } }));
    expect(got.score).toBe(100);
    expect(got.dimensions).toEqual({ sceneMatch: 0, actionMatch: 100, moodMatch: 90, composition: 70 });
  });

  it('unreadable replies throw (never a silent pass)', () => {
    expect(() => parseAuditReply('I cannot see the image.')).toThrow(AuditParseError);
    expect(() => parseAuditReply('{"issues":["no score at all"]}')).toThrow(AuditParseError);
    expect(() => parseAuditReply('')).toThrow(AuditParseError);
  });

  it('a red flag caps the score below the failure band, whatever the model scored', () => {
    const got = parseAuditReply(reply({ ...valid, score: 92, issues: ['warped hands on the child'] }));
    expect(got.score).toBeLessThan(50);
    expect(got.repair).toContain('warped hands');
  });

  it('"no text or watermark" is a clean frame, not a red flag', () => {
    const got = parseAuditReply(reply({ ...valid, score: 88, issues: ['No text or watermark.'] }));
    expect(got.score).toBe(88);
  });

  it('redFlags names only the issues that really trip a rule', () => {
    expect(redFlags(['off-scene: a city street instead of the gate'])).toHaveLength(1);
    expect(redFlags(['a watermark in the corner'])).toHaveLength(1);
    expect(redFlags(['the shot is a bit flat'])).toHaveLength(0);
  });
});

describe('bands and the gate', () => {
  it('pass ≥75, warn 50–74, fail <50', () => {
    expect(auditBand(100)).toBe('pass');
    expect(auditBand(75)).toBe('pass');
    expect(auditBand(74)).toBe('warn');
    expect(auditBand(50)).toBe('warn');
    expect(auditBand(49)).toBe('fail');
    expect(auditBand(0)).toBe('fail');
  });

  it('the assembly gate is 70, stricter than the warn band', () => {
    expect(AUDIT_GATE).toBe(70);
    expect(clearsGate(70)).toBe(true);
    expect(clearsGate(69)).toBe(false);
    expect(clearsGate(undefined)).toBe(false);
  });
});

describe('auditPrompt', () => {
  it('carries scene, action, mood and the spoken line', () => {
    const { system, user } = auditPrompt({ scene: 'Pagar rumah at dusk', action: 'Jingga sits by the gate', mood: 'quiet longing', dialogue: 'Jingga menunggu.' });
    expect(system).toContain('"score"');
    expect(system).toMatch(/red flag/i);
    expect(user).toContain('Pagar rumah at dusk');
    expect(user).toContain('Jingga sits by the gate');
    expect(user).toContain('quiet longing');
    expect(user).toContain('Jingga menunggu.');
    // the spoken line is audio, never burned into the frame
    expect(user).toMatch(/must not appear as on-screen text/i);
  });

  it('names which images are the take and which are references', () => {
    expect(auditPrompt({ scene: 'a' }, 1).user).toMatch(/image 1 is the take/i);
    expect(auditPrompt({ scene: 'a' }, 3, 3).user).toMatch(/images 1-3 are frames of the take/i);
    expect(auditPrompt({ scene: 'a' }, 2).user).toMatch(/image 2 is a reference/i);
  });
});

describe('auditShot', () => {
  it('sends base64 data URLs, the model, JSON mode and usage cost; returns the cost', async () => {
    const [frame] = imagesDir(1);
    const { fetchImpl, calls } = fakeFetch(reply(valid), 0.0012);
    const got = await auditShot({ images: [frame!], expectation: { scene: 'a gate at dusk' }, model: 'google/gemini-2.5-flash', apiKey: 'test-key-not-real', fetch: fetchImpl });
    expect(got.score).toBe(78);
    expect(got.costUsd).toBeCloseTo(0.0012, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/chat\/completions$/);
    expect(calls[0]!.body.model).toBe('google/gemini-2.5-flash');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body.usage).toEqual({ include: true });
    const messages = calls[0]!.body.messages as Array<{ role: string; content: unknown }>;
    const parts = messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]!.type).toBe('text');
    expect(parts[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    expect(parts[1]!.image_url!.url).toContain(png(1).toString('base64').slice(0, 40));
  });

  it('caps at three images (the take first, references after)', async () => {
    expect(MAX_AUDIT_IMAGES).toBe(3);
    const images = imagesDir(5);
    const { fetchImpl, calls } = fakeFetch(reply(valid), 0.001);
    await auditShot({ images, expectation: {}, model: 'google/gemini-2.5-flash', apiKey: 'test-key-not-real', fetch: fetchImpl });
    const parts = (calls[0]!.body.messages as Array<{ content: Array<{ type: string }> }>)[1]!.content;
    // the wire contract, spelled out: never more than three image parts
    expect(parts.filter(p => p.type === 'image_url')).toHaveLength(3);
  });

  it('cost 0 when OpenRouter reports none', async () => {
    const { fetchImpl } = fakeFetch(reply(valid));
    const got = await auditShot({ images: imagesDir(1), expectation: {}, model: 'm/x', apiKey: 'test-key-not-real', fetch: fetchImpl });
    expect(got.costUsd).toBe(0);
  });

  it('a garbage reply throws and an empty image list is refused', async () => {
    const { fetchImpl } = fakeFetch('sure, it looks nice');
    await expect(auditShot({ images: imagesDir(1), expectation: {}, model: 'm/x', apiKey: 'test-key-not-real', fetch: fetchImpl })).rejects.toThrow(AuditParseError);
    await expect(auditShot({ images: [], expectation: {}, model: 'm/x', apiKey: 'test-key-not-real', fetch: fetchImpl })).rejects.toThrow(/minimal satu gambar/i);
  });

  it('skips missing files instead of sending an empty image', async () => {
    const [frame] = imagesDir(1);
    const { fetchImpl, calls } = fakeFetch(reply(valid), 0);
    await auditShot({ images: [join(frame!, 'nope.png'), frame!], expectation: {}, model: 'm/x', apiKey: 'test-key-not-real', fetch: fetchImpl });
    const parts = (calls[0]!.body.messages as Array<{ content: Array<{ type: string }> }>)[1]!.content;
    expect(parts.filter(p => p.type === 'image_url')).toHaveLength(1);
  });
});

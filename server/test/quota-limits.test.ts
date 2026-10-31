import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LimitInputError, LimitsStore, parseUserLimits } from '../src/quota/limits.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'quota-limits-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const store = () => new LimitsStore(dir, id => id === 'admin');

describe('limits defaults and overrides', () => {
  it('non-admin: ElevenLabs 2.000/day, 5.000/30 days, 2.500 per render; Flow and OpenRouter unlimited', async () => {
    const limits = store(); await limits.init();
    expect(limits.resolve('member', 'elevenChars')).toEqual({ perDay: 2000, per30d: 5000, perRender: 2500 });
    expect(limits.resolve('member', 'flowCredits')).toBeUndefined();
    expect(limits.resolve('member', 'openrouterUsd')).toBeUndefined();
  });
  it('admin and system users are unlimited', async () => {
    const limits = store(); await limits.init();
    expect(limits.resolve('admin', 'elevenChars')).toBeUndefined();
    expect(limits.resolve('system:axcel', 'elevenChars')).toBeUndefined();
  });
  it('an admin-set limit replaces the default for that user only, and survives a restart', async () => {
    const limits = store(); await limits.init();
    await limits.set('member', { elevenChars: { perDay: 500, per30d: null }, flowCredits: { perDay: 20 } });
    expect(limits.resolve('member', 'elevenChars')).toEqual({ perDay: 500, per30d: null });
    expect(limits.resolve('other', 'elevenChars')).toEqual({ perDay: 2000, per30d: 5000, perRender: 2500 });
    const again = store(); await again.init();
    expect(again.resolve('member', 'flowCredits')).toEqual({ perDay: 20 });
    await again.set('member', {});
    expect(again.resolve('member', 'flowCredits')).toBeUndefined();
    expect(again.resolve('member', 'elevenChars')?.perDay).toBe(2000);
  });
  it('rejects anything but numbers >= 0 or null, known kinds and known fields', () => {
    for (const bad of [null, [], { nope: {} }, { elevenChars: { perYear: 1 } }, { elevenChars: { perDay: -1 } }, { elevenChars: { perDay: '5' } }, { elevenChars: 3 }, { elevenChars: { perDay: Infinity } }]) {
      expect(() => parseUserLimits(bad)).toThrow(LimitInputError);
    }
    expect(parseUserLimits({ openrouterUsd: { perDay: 1.5 } })).toEqual({ openrouterUsd: { perDay: 1.5 } });
  });
});

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VOICE } from '../src/dub/service.js';
import { creditsFor, ID, makeHarness, type Harness } from './dub-harness.js';

let h: Harness;
afterEach(() => h?.cleanup());
const one = { kind: 'shots', shotIds: ['s1'] } as const;
const all = { kind: 'all' } as const;
const mp3s = (hh: Harness) => readdirSync(join(hh.dir, ID, 'dub')).filter(f => f.endsWith('.mp3')).sort();
const renderOne = async (hh: Harness) => { await hh.svc.render(ID, one, { owner: 'u1', confirmCredits: await creditsFor(hh, one) }); await hh.svc.idle(ID); };
/** The hash formula as it was BEFORE the text was normalised (what is in dub.json of dubs that already exist). */
const legacyHash = (text: string, voiceId: string, modelId = 'eleven_multilingual_v2') =>
  createHash('sha256').update(JSON.stringify({ t: text, v: voiceId, m: modelId, l: 'id', s: DEFAULT_VOICE })).digest('hex').slice(0, 16);

describe('S8: the text is normalised before it is hashed, counted and spoken', () => {
  it('double / trailing / odd spaces and NFC do not make a dub stale, change the characters, or cost anything', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await renderOne(h);
    expect(h.calls).toHaveLength(1);
    for (const spaced of ['Aku  mau yang indah.', '  Aku mau  yang   indah.  ', 'Aku\u00a0mau yang indah.', 'Aku mau\nyang indah.']) {
      await h.svc.setShot(ID, 's1', { text: spaced });
      const st = await h.svc.state(ID);
      expect(st.shots[0]).toMatchObject({ status: 'done', chars: 'Aku mau yang indah.'.length, text: 'Aku mau yang indah.' });
      expect((await h.svc.plan(ID, one)).credits).toBe(0);
    }
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits: 0 });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
  });

  it('the provider receives the normalised text (so the characters billed are the characters shown)', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.setShot(ID, 's1', { text: '  Aku   mau   yang indah.  ' });
    expect((await h.svc.plan(ID, one)).chars).toBe('Aku mau yang indah.'.length);
    await renderOne(h);
    expect(h.calls[0]!.text).toBe('Aku mau yang indah.');
  });

  it('MIGRATION: a dub rendered before the change (hash of the un-normalised text) is still fresh: not stale, not charged again, still mixed in', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.setShot(ID, 's1', { text: 'Aku  mau yang indah.' }); // raw override with a double space
    const dir = join(h.dir, ID);
    mkdirSync(join(dir, 'dub'), { recursive: true });
    writeFileSync(join(dir, 'dub', 's1-legacy00.mp3'), Buffer.from('OLD-AUDIO'));
    const doc = JSON.parse(readFileSync(join(dir, 'dub.json'), 'utf8'));
    Object.assign(doc.shots.s1, { hash: legacyHash('Aku  mau yang indah.', 'V1'), file: 'dub/s1-legacy00.mp3', seconds: 2.5, chars: 20, atMs: 1 });
    writeFileSync(join(dir, 'dub.json'), JSON.stringify(doc));
    expect((await h.svc.state(ID)).shots[0]).toMatchObject({ status: 'done' });
    expect((await h.svc.plan(ID, one)).credits).toBe(0);
    expect(Object.keys((await h.svc.dubFor(ID)).shots)).toEqual(['s1']);
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await creditsFor(h, all) });
    await h.svc.idle(ID);
    expect(h.calls.map(c => c.text)).toEqual(['Tapi tangan itu membelokkanku.']); // only the shot that never had a dub
  });
});

describe('S8: going back to a recent text spends nothing (hash archive)', () => {
  it('A → B → A: the third render is a restore, the provider is called twice in total, and the video is told to be rebuilt', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await renderOne(h); // "Aku mau yang indah."
    await h.svc.setShot(ID, 's1', { text: 'Aku mau yang lain.' });
    await renderOne(h);
    expect(h.calls).toHaveLength(2);
    h.stale.length = 0;
    await h.svc.setShot(ID, 's1', { text: null }); // back to the narration of the shot
    expect((await h.svc.state(ID)).shots[0]).toMatchObject({ status: 'done', text: 'Aku mau yang indah.' });
    expect((await h.svc.plan(ID, one)).credits).toBe(0);
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits: 0 });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(2);
    const dub = (await h.svc.dubFor(ID)).shots.s1!;
    expect(readFileSync(dub.file, 'utf8')).toBe('MP3:Aku mau yang indah.:V1'); // the audio of the OLD text, not the other one
    expect(h.stale.length).toBeGreaterThan(0);
  });

  it('a settings change and back (voice slider) is also free; the 3 latest earlier dubs are kept, older ones and their files are dropped', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await renderOne(h);
    await h.svc.updateSettings(ID, { voice: { stability: 0.9 } });
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('stale');
    await h.svc.updateSettings(ID, { voice: { stability: 0.5 } });
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('done');
    expect(h.calls).toHaveLength(1);
    // four different texts in a row: the first one falls out of the archive (3 earlier + the current one)
    for (const t of ['Satu.', 'Dua.', 'Tiga.', 'Empat.']) { await h.svc.setShot(ID, 's1', { text: t }); await renderOne(h); }
    expect(h.calls).toHaveLength(5);
    expect(mp3s(h)).toHaveLength(4);
    await h.svc.setShot(ID, 's1', { text: 'Dua.' });
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('done'); // within the last 3
    await h.svc.setShot(ID, 's1', { text: null });
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('stale'); // evicted: has to be paid again
  });

  it('remove() deletes the archived audio too', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await renderOne(h);
    await h.svc.setShot(ID, 's1', { text: 'Teks lain.' });
    await renderOne(h);
    expect(mp3s(h)).toHaveLength(2);
    await h.svc.remove(ID, 's1');
    expect(mp3s(h)).toHaveLength(0);
  });
});

describe('S8: resume() never makes a shot twice', () => {
  const crash = async (hh: Harness, patch: (doc: any, dir: string) => void) => {
    await hh.svc.updateSettings(ID, { voiceId: 'V1' });
    const dir = join(hh.dir, ID);
    const doc = JSON.parse(readFileSync(join(dir, 'dub.json'), 'utf8'));
    patch(doc, dir);
    writeFileSync(join(dir, 'dub.json'), JSON.stringify(doc));
  };
  it('a shot left "running" whose fresh file is already there: zero calls', async () => {
    h = makeHarness();
    await renderOne((await (async () => { await h.svc.updateSettings(ID, { voiceId: 'V1' }); return h; })()));
    const dir = join(h.dir, ID);
    const doc = JSON.parse(readFileSync(join(dir, 'dub.json'), 'utf8'));
    doc.shots.s1.status = 'running';
    writeFileSync(join(dir, 'dub.json'), JSON.stringify(doc));
    h.calls.length = 0;
    await h.svc.resume([ID]);
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(0);
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('done');
  });

  it('crash between "audio saved" and "dub.json written": the mp3 of that exact text is adopted, not bought again', async () => {
    h = makeHarness();
    await crash(h, (doc, dir) => {
      mkdirSync(join(dir, 'dub'), { recursive: true });
      const hash = legacyHash('Aku mau yang indah.', 'V1');
      writeFileSync(join(dir, 'dub', `s1-${hash.slice(0, 8)}.mp3`), Buffer.from('SAVED-BEFORE-CRASH'));
      doc.shots = { s1: { status: 'running' } };
    });
    await h.svc.resume([ID]);
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(0);
    const st = (await h.svc.state(ID)).shots[0]!;
    expect(st).toMatchObject({ status: 'done', seconds: 3.2 });
    expect(existsSync((await h.svc.dubFor(ID)).shots.s1!.file)).toBe(true);
  });

  it('a queued shot with nothing on disk is made once (the user already confirmed it)', async () => {
    h = makeHarness();
    await crash(h, doc => { doc.shots = { s1: { status: 'queued' } }; });
    await h.svc.resume([ID]);
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('done');
  });
});

describe('S8: the balance gate', () => {
  it('a known balance below the estimate refuses with INSUFFICIENT before any call or mark', async () => {
    h = makeHarness({ balance: async () => 10 });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const need = await creditsFor(h, all);
    await expect(h.svc.render(ID, all, { owner: 'u1', confirmCredits: need })).rejects.toMatchObject({ code: 'INSUFFICIENT' });
    expect(h.calls).toHaveLength(0);
    expect((await h.svc.state(ID)).shots.every(s => s.status === 'none')).toBe(true);
  });
  it('an unknown balance (scoped key, provider unreachable) does not block; an exactly sufficient one does not either', async () => {
    h = makeHarness({ balance: async () => undefined });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits: await creditsFor(h, one) });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
    const exact = makeHarness({ balance: async () => 'Aku mau yang indah.'.length });
    try {
      await exact.svc.updateSettings(ID, { voiceId: 'V1' });
      await exact.svc.render(ID, one, { owner: 'u1', confirmCredits: await creditsFor(exact, one) });
      await exact.svc.idle(ID);
      expect(exact.calls).toHaveLength(1);
    } finally { exact.cleanup(); }
  });
  it('a balance call that throws is "unknown", never a reason to refuse', async () => {
    h = makeHarness({ balance: async () => { throw new Error('network'); } });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits: await creditsFor(h, one) });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
  });
  it('nothing to render never asks the provider for the balance', async () => {
    let asked = 0;
    h = makeHarness({ balance: async () => { asked++; return 0; } });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.setShot(ID, 's1', { text: '' }); // empty override = narration; silence both
    h.current.board.shots.forEach(s => { s.silent = true; });
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: 0 });
    expect(asked).toBe(0);
  });
});

describe('S8: shots with text but no fresh dub, in a project that already has dubs', () => {
  it('dubFor lists them (stale and never-dubbed); a project with no dub at all, and silent shots, are not listed', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    expect((await h.svc.dubFor(ID)).staleShots ?? []).toEqual([]); // not a dubbed project yet
    await renderOne(h);
    expect((await h.svc.dubFor(ID)).staleShots).toEqual(['s2']); // s2 never dubbed
    await h.svc.setShot(ID, 's1', { text: 'Teks baru yang belum dirender.' });
    expect((await h.svc.dubFor(ID)).staleShots).toEqual(['s1', 's2']);
    h.current.board.shots[1]!.silent = true;
    expect((await h.svc.dubFor(ID)).staleShots).toEqual(['s1']);
  });
});

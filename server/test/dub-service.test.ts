import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DubService, type DubDeps } from '../src/dub/service.js';
import { DubError, type SynthesizeInput } from '../src/dub/elevenlabs.js';
import { FairQueue } from '../src/lib/fair-queue.js';
import type { Storyboard } from '../src/stories/storyboard.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dub-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const board = (): Storyboard => ({
  title: 'Lentera',
  scenes: [{ id: 'jalan', title: 'Jalan', shots: ['s1', 's2'] }, { id: 'hutan', title: 'Hutan', shots: ['s3', 's4'] }],
  shots: [
    { id: 's1', prompt: 'p1', narration: 'Aku mau yang indah.' },
    { id: 's2', prompt: 'p2', intent: { narration: 'Tapi tangan itu membelokkanku.' } } as never,
    { id: 's3', prompt: 'p3', narration: 'Terangnya cukup untuk satu langkah.', caption: 'teks tampilan beda' },
    { id: 's4', prompt: 'p4', silent: true }
  ]
} as Storyboard);

type Harness = ReturnType<typeof make>;
function make(options: { fail?: (input: SynthesizeInput) => Error | undefined; configured?: boolean; concurrency?: number; words?: [string, number, number][] } = {}) {
  const calls: SynthesizeInput[] = [];
  const stale: string[] = [];
  let running = 0; let peak = 0;
  const deps: DubDeps = {
    dir: id => join(dir, id),
    board: async () => current,
    markStale: async id => { stale.push(id); },
    client: {
      configured: () => options.configured ?? true,
      synthesize: async input => {
        running++; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, 5));
        running--;
        calls.push(input);
        const err = options.fail?.(input);
        if (err) throw err;
        return { audio: Buffer.from(`MP3:${input.text}:${input.voiceId}`), keyId: 'k1', ...(options.words ? { words: options.words } : {}) };
      }
    },
    queue: new FairQueue({ concurrency: options.concurrency ?? 4 }),
    probe: async () => 3.2
  };
  const svc = new DubService(deps);
  return { svc, calls, stale, peak: () => peak };
}
let current: Storyboard = board();
beforeEach(() => { current = board(); });
const ID = 'story_aaaaaaaaaaaaaaaa';
const confirmFor = async (h: Harness, scope: Parameters<Harness['svc']['plan']>[1]) => (await h.svc.plan(ID, scope)).credits;

describe('DubService word timings', () => {
  const words: [string, number, number][] = [['Aku', 0, 0.3], ['mau', 0.35, 0.7], ['yang', 0.75, 1.0], ['indah.', 1.05, 1.6]];

  it('keeps the word timings the voice reported and hands them to the assembler', async () => {
    const h = make({ words });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.render(ID, { kind: 'shots', shotIds: ['s1'] }, { owner: 'u1', confirmCredits: await confirmFor(h, { kind: 'shots', shotIds: ['s1'] }) });
    await h.svc.idle(ID);
    const dub = await h.svc.dubFor(ID);
    expect(dub.shots.s1!.words).toEqual(words);
  });

  it('estimates timings for a dub that was rendered without any, so older audio still gets a sweep', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.render(ID, { kind: 'shots', shotIds: ['s1'] }, { owner: 'u1', confirmCredits: await confirmFor(h, { kind: 'shots', shotIds: ['s1'] }) });
    await h.svc.idle(ID);
    const w = (await h.svc.dubFor(ID)).shots.s1!.words!;
    expect(w.map(x => x[0])).toEqual(['Aku', 'mau', 'yang', 'indah.']);
    expect(w[w.length - 1]![2]).toBeLessThanOrEqual(3.2);
  });

  it('drops the timings together with the audio when the text changes (a stale dub is never mixed, so never swept)', async () => {
    const h = make({ words });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.render(ID, { kind: 'shots', shotIds: ['s1'] }, { owner: 'u1', confirmCredits: await confirmFor(h, { kind: 'shots', shotIds: ['s1'] }) });
    await h.svc.idle(ID);
    current.shots[0]!.narration = 'Sesuatu yang lain sama sekali.';
    expect((await h.svc.dubFor(ID)).shots.s1).toBeUndefined();
  });
});

describe('DubService.state / plan', () => {
  it('uses the narration (not the caption) as the text, skips silent shots, and counts characters', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const st = await h.svc.state(ID);
    expect(st.shots.map(s => [s.shotId, s.text, s.status])).toEqual([
      ['s1', 'Aku mau yang indah.', 'none'], ['s2', 'Tapi tangan itu membelokkanku.', 'none'],
      ['s3', 'Terangnya cukup untuk satu langkah.', 'none'], ['s4', '', 'none']
    ]);
    expect(st.shots[3]!.skipped).toBe(true);
    expect(st.shots.map(s => s.sceneId)).toEqual(['jalan', 'jalan', 'hutan', 'hutan']);
    expect(st.totals).toMatchObject({ dubbable: 3, done: 0 });
    expect(st.totals.chars).toBe('Aku mau yang indah.'.length + 'Tapi tangan itu membelokkanku.'.length + 'Terangnya cukup untuk satu langkah.'.length);
  });

  it('plan: scope all / scene / shots, with the credit estimate of the chosen model', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1', modelId: 'eleven_flash_v2_5' });
    const all = await h.svc.plan(ID, { kind: 'all' });
    expect(all.shotIds).toEqual(['s1', 's2', 's3']);
    expect(all.credits).toBe(all.chars * 0.5);
    expect((await h.svc.plan(ID, { kind: 'scene', sceneId: 'hutan' })).shotIds).toEqual(['s3']);
    expect((await h.svc.plan(ID, { kind: 'shots', shotIds: ['s2'] })).shotIds).toEqual(['s2']);
    await expect(h.svc.plan(ID, { kind: 'scene', sceneId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.svc.plan(ID, { kind: 'shots', shotIds: ['zzz'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DubService.render', () => {
  it('refuses to start unless the caller confirms exactly the credits the server estimated', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const scope = { kind: 'all' } as const;
    const need = await confirmFor(h, scope);
    await expect(h.svc.render(ID, scope, { owner: 'u1' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await expect(h.svc.render(ID, scope, { owner: 'u1', confirmCredits: need - 1 })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(h.calls).toHaveLength(0);
    expect((await h.svc.state(ID)).shots.every(s => s.status === 'none')).toBe(true);
  });

  it('renders the planned shots, stores the mp3s, learns their length and marks the video stale', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1', modelId: 'eleven_multilingual_v2' });
    const scope = { kind: 'all' } as const;
    await h.svc.render(ID, scope, { owner: 'u1', confirmCredits: await confirmFor(h, scope) });
    await h.svc.idle(ID);
    const st = await h.svc.state(ID);
    expect(st.shots.map(s => s.status)).toEqual(['done', 'done', 'done', 'none']);
    expect(st.shots[0]).toMatchObject({ seconds: 3.2 });
    expect(readdirSync(join(dir, ID, 'dub')).filter(f => f.endsWith('.mp3'))).toHaveLength(3);
    expect(h.stale.length).toBeGreaterThan(0);
    expect(h.calls.map(c => c.text)).toContain('Aku mau yang indah.');
    expect(h.calls.every(c => c.modelId === 'eleven_multilingual_v2' && c.voiceId === 'V1')).toBe(true);
  });

  it('a second render with nothing changed makes no provider call (no credits are spent twice)', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const scope = { kind: 'all' } as const;
    await h.svc.render(ID, scope, { owner: 'u1', confirmCredits: await confirmFor(h, scope) });
    await h.svc.idle(ID);
    const before = h.calls.length;
    expect(await confirmFor(h, scope)).toBe(0);
    await h.svc.render(ID, scope, { owner: 'u1', confirmCredits: 0 });
    await h.svc.idle(ID);
    expect(h.calls.length).toBe(before);
  });

  it('after a text edit only that shot is stale and only it is rendered again; the old audio is archived', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const all = { kind: 'all' } as const;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    const files1 = readdirSync(join(dir, ID, 'dub')).sort();
    await h.svc.setShot(ID, 's2', { text: 'Tangan itu membelokkan langkahku.' });
    expect((await h.svc.state(ID)).shots.map(s => s.status)).toEqual(['done', 'stale', 'done', 'none']);
    const before = h.calls.length;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    expect(h.calls.length - before).toBe(1);
    expect(h.calls.at(-1)!.text).toBe('Tangan itu membelokkan langkahku.');
    const files2 = readdirSync(join(dir, ID, 'dub')).sort();
    // the replaced s2 audio is archived (so going back to that text is free), not piled up: at most 3 earlier dubs per shot (see dub-money.test.ts)
    expect(files2).toHaveLength(files1.length + 1);
    expect(files2.filter(f => f.startsWith('s2-'))).toHaveLength(2);
    expect(files2.filter(f => f.startsWith('s2-'))).not.toEqual(files1.filter(f => f.startsWith('s2-')));
  });

  it('a per-shot voice override is used for that shot only; a settings change makes every shot stale', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'NARATOR' });
    await h.svc.setShot(ID, 's1', { voiceId: 'BAYU' });
    const scope = { kind: 'shots', shotIds: ['s1', 's2'] } as const;
    await h.svc.render(ID, scope, { owner: 'u1', confirmCredits: await confirmFor(h, scope) });
    await h.svc.idle(ID);
    expect(Object.fromEntries(h.calls.map(c => [c.text, c.voiceId]))).toMatchObject({ 'Aku mau yang indah.': 'BAYU', 'Tapi tangan itu membelokkanku.': 'NARATOR' });
    await h.svc.updateSettings(ID, { voice: { stability: 0.9 } });
    expect((await h.svc.state(ID)).shots.slice(0, 2).map(s => s.status)).toEqual(['stale', 'stale']);
  });

  it('gives each line its neighbours as context so the intonation flows', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const scope = { kind: 'shots', shotIds: ['s2'] } as const;
    await h.svc.render(ID, scope, { owner: 'u1', confirmCredits: await confirmFor(h, scope) });
    await h.svc.idle(ID);
    expect(h.calls[0]).toMatchObject({ previousText: 'Aku mau yang indah.', nextText: 'Terangnya cukup untuk satu langkah.' });
  });

  it('one failing shot is marked failed with the reason; the others finish; a retry renders only the failed one', async () => {
    let failS2 = true;
    const h = make({ fail: input => (failS2 && input.text.startsWith('Tapi') ? new DubError('UNAVAILABLE', 'Semua API key sedang di-cooldown') : undefined) });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const all = { kind: 'all' } as const;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    const st = await h.svc.state(ID);
    expect(st.shots.map(s => s.status)).toEqual(['done', 'failed', 'done', 'none']);
    expect(st.shots[1]!.error).toMatch(/cooldown/);
    failS2 = false;
    const before = h.calls.length;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    expect(h.calls.length - before).toBe(1);
    expect((await h.svc.state(ID)).shots.map(s => s.status)).toEqual(['done', 'done', 'done', 'none']);
  });

  it('refuses when no voice is chosen or no key is configured, before anything is marked or spent', async () => {
    const h = make();
    await expect(h.svc.render(ID, { kind: 'all' }, { owner: 'u', confirmCredits: 99 })).rejects.toMatchObject({ code: 'INVALID' });
    const off = make({ configured: false });
    await off.svc.updateSettings(ID, { voiceId: 'V1' });
    await expect(off.svc.render(ID, { kind: 'all' }, { owner: 'u', confirmCredits: 99 })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(off.calls).toHaveLength(0);
  });

  it('text over the per-request limit is flagged and cannot be rendered', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.setShot(ID, 's1', { text: 'x'.repeat(2501) });
    expect((await h.svc.state(ID)).shots[0]).toMatchObject({ tooLong: true });
    await expect(h.svc.plan(ID, { kind: 'shots', shotIds: ['s1'] })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('never runs more provider calls at once than the queue allows', async () => {
    const h = make({ concurrency: 2 });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const all = { kind: 'all' } as const;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    expect(h.peak()).toBeLessThanOrEqual(2);
  });

  it('cancel drops what has not started; what already finished is kept', async () => {
    const h = make({ concurrency: 1 });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const all = { kind: 'all' } as const;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.cancel(ID);
    await h.svc.idle(ID);
    const statuses = (await h.svc.state(ID)).shots.map(s => s.status);
    expect(statuses.filter(s => s === 'queued')).toHaveLength(0);
    expect(statuses.filter(s => s === 'done').length).toBeLessThan(3);
  });
});

describe('DubService.dubFor / remove / resume', () => {
  it('gives the assembler only fresh finished dubs, as absolute files with their length', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const all = { kind: 'all' } as const;
    await h.svc.render(ID, all, { owner: 'u1', confirmCredits: await confirmFor(h, all) });
    await h.svc.idle(ID);
    const plan = await h.svc.dubFor(ID);
    expect(Object.keys(plan.shots).sort()).toEqual(['s1', 's2', 's3']);
    expect(plan.shots.s1!.file.startsWith(join(dir, ID, 'dub'))).toBe(true);
    expect(existsSync(plan.shots.s1!.file)).toBe(true);
    expect(plan.shots.s1!.seconds).toBe(3.2);
    await h.svc.setShot(ID, 's1', { text: 'Teks baru yang belum dirender.' });
    expect(Object.keys((await h.svc.dubFor(ID)).shots).sort()).toEqual(['s2', 's3']); // stale dub is not mixed in
  });

  it('remove deletes the file and the entry and marks the video stale', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits: await confirmFor(h, one) });
    await h.svc.idle(ID);
    h.stale.length = 0;
    await h.svc.remove(ID, 's1');
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('none');
    expect(readdirSync(join(dir, ID, 'dub')).filter(f => f.endsWith('.mp3'))).toHaveLength(0);
    expect(h.stale.length).toBe(1);
  });

  it('after a restart, shots that were queued are queued again (the user already confirmed them)', async () => {
    const h = make();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, ID), { recursive: true });
    // simulate a crash: a doc left with a queued shot
    const docPath = join(dir, ID, 'dub.json');
    const doc = JSON.parse((await import('node:fs')).readFileSync(docPath, 'utf8'));
    doc.shots = { s1: { status: 'queued' } };
    writeFileSync(docPath, JSON.stringify(doc));
    const fresh = make();
    await fresh.svc.resume([ID]);
    await fresh.svc.idle(ID);
    expect((await fresh.svc.state(ID)).shots[0]!.status).toBe('done');
  });
});

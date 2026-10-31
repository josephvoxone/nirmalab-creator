import { afterEach, describe, expect, it } from 'vitest';
import type { Storyboard } from '../src/stories/storyboard.js';
import { creditsFor, ID, makeHarness, type Harness } from './dub-harness.js';

let h: Harness;
afterEach(() => h?.cleanup());
const LONG = 'Ini adalah kalimat yang sangat panjang sekali, jauh melebihi apa yang muat di dalam satu klip pendek berdurasi enam detik, sehingga harus dipercepat dan dipotong.'; // 163 chars
const board = (extra: Partial<Storyboard> = {}, shots?: Storyboard['shots']): Storyboard => ({
  title: 'Fit', scenes: [{ id: 'sc', title: 'Satu', shots: ['s1', 's2', 's3'] }],
  shots: shots ?? [
    { id: 's1', prompt: 'p1', narration: 'Aku mau yang indah.' },
    { id: 's2', prompt: 'p2', narration: LONG },
    { id: 's3', prompt: 'p3', narration: LONG }
  ], ...extra
} as Storyboard);

describe('S7: ShotView.fit in the dub state', () => {
  it('each spoken shot has a fit (ratio, level, window); a shot without text has none; the LAST shot never blocks', async () => {
    h = makeHarness({ board: board({}, [...board().shots, { id: 's4', prompt: 'p4', silent: true }] as never) });
    const st = await h.svc.state(ID);
    expect(st.shots.map(s => s.fit?.level)).toEqual(['ok', 'block', 'block', undefined]);
    // the same story with that line as the last shot: hold (the frame is held), not block
    h.current.board = board();
    const last = (await h.svc.state(ID)).shots.map(s => s.fit?.level);
    expect(last).toEqual(['ok', 'block', 'hold']);
    expect((await h.svc.state(ID)).shots[2]!.fit!.holdSec).toBeGreaterThan(0);
    expect((await h.svc.state(ID)).shots[1]!.fit).toMatchObject({ windowSec: 5.437, suggestChars: expect.any(Number) });
  });

  it('the window follows the real clip length of the story, a trim, and the crossfade of the board', async () => {
    h = makeHarness({ board: board({ crossfade: 0.5 }, [
      { id: 's1', prompt: 'p1', narration: 'Aku mau yang indah.' },
      { id: 's2', prompt: 'p2', narration: 'Aku mau yang indah.', trim: { out: 3 } },
      { id: 's3', prompt: 'p3', narration: 'Aku mau yang indah.' }] as never), clipSeconds: async () => ({ s1: 8, s2: 8, s3: 5 }) });
    const w = (await h.svc.state(ID)).shots.map(s => s.fit!.windowSec);
    expect(w[0]).toBeCloseTo(8 - 0.3 - 0.5, 3);
    expect(w[1]).toBeCloseTo(3 - 0.3 - 0.5, 3);
    expect(w[2]).toBeCloseTo(5 - 0.3 - 0.2, 3); // last
  });

  it('a slower voice speed lengthens every prediction; a finished dub is judged by its REAL length', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const before = (await h.svc.state(ID)).shots[0]!.fit!;
    expect(before.basis).toBe('predicted');
    await h.svc.updateSettings(ID, { voice: { speed: 0.7 } });
    expect((await h.svc.state(ID)).shots[0]!.fit!.predictedSec).toBeGreaterThan(before.predictedSec * 1.4);
    await h.svc.updateSettings(ID, { voice: { speed: 1 } });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    await h.svc.render(ID, one, { owner: 'u', confirmCredits: await creditsFor(h, one) });
    await h.svc.idle(ID);
    expect((await h.svc.state(ID)).shots[0]!.fit).toMatchObject({ basis: 'measured', predictedSec: 3.2 }); // probe says 3.2 s
  });
});

describe('S7: render refuses TOO_LONG unless the writer accepts it', () => {
  const both = { kind: 'shots', shotIds: ['s1', 's2'] } as const;
  it('plan lists the blocked shots; render without acceptTooLong → TOO_LONG, nothing called, nothing marked (the fine shot waits too)', async () => {
    h = makeHarness({ board: board() });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const plan = await h.svc.plan(ID, both);
    expect(plan.blocked).toEqual(['s2']);
    await expect(h.svc.render(ID, both, { owner: 'u', confirmCredits: plan.credits })).rejects.toMatchObject({ code: 'TOO_LONG' });
    expect(h.calls).toHaveLength(0);
    expect((await h.svc.state(ID)).shots.map(s => s.status)).toEqual(['none', 'none', 'none']);
  });

  it('the message names the shot and how much to cut; the money rules still apply (a wrong confirmation is still refused)', async () => {
    h = makeHarness({ board: board() });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const err = await h.svc.render(ID, both, { owner: 'u', confirmCredits: 1 }).catch(e => e);
    expect(err).toMatchObject({ code: 'TOO_LONG' });
    expect(String(err.message)).toMatch(/s2/);
    expect(String(err.message)).toMatch(/\d+ karakter/);
    const plan = await h.svc.plan(ID, both);
    await expect(h.svc.render(ID, both, { owner: 'u', confirmCredits: plan.credits + 5, acceptTooLong: true })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(h.calls).toHaveLength(0);
  });

  it('with acceptTooLong the blocked shot is rendered like any other (exactly one call per shot)', async () => {
    h = makeHarness({ board: board() });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const plan = await h.svc.plan(ID, both);
    await h.svc.render(ID, both, { owner: 'u', confirmCredits: plan.credits, acceptTooLong: true });
    await h.svc.idle(ID);
    expect(h.calls.map(c => c.text)).toEqual(['Aku mau yang indah.', LONG]);
  });

  it('shortening the line clears the block; the last shot (hold) and warn-level shots never need acceptTooLong', async () => {
    h = makeHarness({ board: board() });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    await h.svc.setShot(ID, 's2', { text: 'Dua jalan, satu pilihan yang berat.' });
    const all = { kind: 'all' } as const;
    const plan = await h.svc.plan(ID, all);
    expect(plan.blocked).toEqual([]);
    await h.svc.render(ID, all, { owner: 'u', confirmCredits: plan.credits }); // s3 is LONG but last: hold, allowed
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(3);
  });

  it('a shot that is already done is not re-checked (no charge, no refusal)', async () => {
    h = makeHarness({ board: board() });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const plan = await h.svc.plan(ID, both);
    await h.svc.render(ID, both, { owner: 'u', confirmCredits: plan.credits, acceptTooLong: true });
    await h.svc.idle(ID);
    await h.svc.render(ID, both, { owner: 'u', confirmCredits: 0 });
    expect(h.calls).toHaveLength(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { creditsFor, ID, makeHarness, type Harness } from './dub-harness.js';

let h: Harness;
afterEach(() => h?.cleanup());
const all = { kind: 'all' } as const;

describe('F2: two overlapping renders of the same shots are charged once', () => {
  it('two parallel render() with the same confirmation call the provider exactly once per shot', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const confirmCredits = await creditsFor(h, all);
    const results = await Promise.allSettled([
      h.svc.render(ID, all, { owner: 'u1', confirmCredits }),
      h.svc.render(ID, all, { owner: 'u1', confirmCredits })
    ]);
    await h.svc.idle(ID);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect(h.calls.map(c => c.text).sort()).toEqual(['Aku mau yang indah.', 'Tapi tangan itu membelokkanku.']);
    expect((await h.svc.state(ID)).shots.map(s => s.status)).toEqual(['done', 'done']);
  });

  it('five clicks at once on one shot are still one provider call', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    const confirmCredits = await creditsFor(h, one);
    await Promise.allSettled(Array.from({ length: 5 }, () => h.svc.render(ID, one, { owner: 'u1', confirmCredits })));
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
  });

  it('two parallel force renders of the same shot while it is being made: one call (nothing is paid for a duplicate click)', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    const confirmCredits = await creditsFor(h, one);
    await Promise.allSettled([
      h.svc.render(ID, one, { owner: 'u1', confirmCredits, force: true }),
      h.svc.render(ID, one, { owner: 'u1', confirmCredits, force: true })
    ]);
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
  });

  it('a deliberate force render AFTER the first finished still renders again (explicit re-render is allowed twice)', async () => {
    h = makeHarness();
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    const confirmCredits = await creditsFor(h, one);
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits });
    await h.svc.idle(ID);
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits, force: true });
    await h.svc.idle(ID);
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits, force: true });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(3);
  });

  it('a failed render releases the lock: the retry is allowed and calls the provider again', async () => {
    let failOnce = true;
    h = makeHarness({ fail: () => { if (failOnce) { failOnce = false; return new Error('boom'); } return undefined; } });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const one = { kind: 'shots', shotIds: ['s1'] } as const;
    const confirmCredits = await creditsFor(h, one);
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits });
    await h.svc.idle(ID);
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('failed');
    await h.svc.render(ID, one, { owner: 'u1', confirmCredits });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(2);
    expect((await h.svc.state(ID)).shots[0]!.status).toBe('done');
  });
});

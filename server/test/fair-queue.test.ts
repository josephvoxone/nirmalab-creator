import { describe, expect, it } from 'vitest';
import { FairQueue, QueueFullError } from '../src/lib/fair-queue.js';

const tick = () => new Promise<void>(r => setImmediate(r));
function gate() { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; }

describe('FairQueue', () => {
  it('never runs more tasks than the concurrency, and runs them all', async () => {
    const q = new FairQueue({ concurrency: 2 });
    let running = 0; let peak = 0;
    const gates = Array.from({ length: 6 }, gate);
    const done = gates.map((g, i) => q.run('u', async () => { running++; peak = Math.max(peak, running); await g.p; running--; return i; }));
    await tick();
    expect(running).toBe(2);
    for (const g of gates) { g.open(); await tick(); }
    expect(await Promise.all(done)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('keeps first-in-first-out order inside one owner', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map(n => q.run('a', async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('is fair between owners: one user with many tasks cannot starve another', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const order: string[] = [];
    const g = gate();
    const first = q.run('a', async () => { order.push('a1'); await g.p; });
    await tick();
    const rest = ['a2', 'a3', 'a4', 'a5'].map(n => q.run('a', async () => { order.push(n); }));
    const b = q.run('b', async () => { order.push('b1'); });
    const c = q.run('c', async () => { order.push('c1'); });
    g.open();
    await Promise.all([first, ...rest, b, c]);
    // b and c are served right after the running task, not after all of a's backlog
    expect(order.slice(0, 4)).toEqual(['a1', 'a2', 'b1', 'c1']);
    expect(order.slice(4)).toEqual(['a3', 'a4', 'a5']);
  });

  it('a failing task rejects its own caller only and the queue keeps going', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const bad = q.run('a', async () => { throw new Error('boom'); });
    const good = q.run('a', async () => 'fine');
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('fine');
    expect(q.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('tells a waiting task its position (1 = next) when it joins and whenever the line changes', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const g = gate();
    const head = q.run('a', async () => { await g.p; });
    await tick();
    const seen: Array<[number, number]> = [];
    const mine = q.run('b', async () => 'ok', { onPosition: (pos, total) => seen.push([pos, total]) });
    expect(seen).toEqual([[1, 1]]);
    const other = q.run('c', async () => 'ok');
    const another = q.run('b', async () => 'ok');
    await tick();
    expect(seen.at(-1)).toEqual([1, 3]); // b is still next; the line behind it grew
    g.open();
    await Promise.all([head, mine, other, another]);
  });

  it('reports running, waiting and the concurrency', async () => {
    const q = new FairQueue({ concurrency: 2 });
    const gates = [gate(), gate(), gate()];
    const all = gates.map(g => q.run('a', () => g.p));
    await tick();
    expect(q.stats()).toMatchObject({ running: 2, waiting: 1, concurrency: 2 });
    gates.forEach(g => g.open());
    await Promise.all(all);
    expect(q.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('a task that is still waiting can be cancelled; it never runs', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const g = gate();
    const head = q.run('a', async () => { await g.p; });
    await tick();
    const ctl = new AbortController();
    let ran = false;
    const waiting = q.run('b', async () => { ran = true; }, { signal: ctl.signal });
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    g.open(); await head;
    await tick();
    expect(ran).toBe(false);
    expect(q.stats().waiting).toBe(0);
  });

  it('refuses new work past maxWaiting instead of growing without bound', async () => {
    const q = new FairQueue({ concurrency: 1, maxWaiting: 2 });
    const g = gate();
    const all = [q.run('a', () => g.p)];
    await tick();
    all.push(q.run('a', async () => 1), q.run('b', async () => 2));
    await expect(q.run('c', async () => 3)).rejects.toBeInstanceOf(QueueFullError);
    g.open();
    await Promise.all(all);
  });

  it('the concurrency can be raised while running and the queue drains faster', async () => {
    const q = new FairQueue({ concurrency: 1 });
    const gates = [gate(), gate(), gate()];
    let running = 0;
    const all = gates.map(g => q.run('a', async () => { running++; await g.p; running--; }));
    await tick();
    expect(running).toBe(1);
    q.setConcurrency(3);
    await tick();
    expect(running).toBe(3);
    gates.forEach(g => g.open());
    await Promise.all(all);
  });
});

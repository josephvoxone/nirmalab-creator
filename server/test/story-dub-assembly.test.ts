import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../src/stories/storyboard.js';
import { finishQueued, serviceSetup } from './bible-board.js';

const board = (): Storyboard => ({
  title: 'Dub', mode: 'cepat', aspect: '9:16',
  shots: [{ id: '01-a', prompt: 'Medium shot. A girl waits.', narration: 'Aku menunggu.' }, { id: '02-b', prompt: 'Close-up. She smiles.', narration: 'Lalu tersenyum.' }]
});

async function ready(extra: Parameters<typeof serviceSetup>[0] = {}, createdBy?: string) {
  const t = serviceSetup(extra);
  const story = await t.service.create(board(), createdBy ? { createdBy } : {});
  await t.service.render(story.id, { force: true });
  await finishQueued(t, 'video');
  await t.service.reconcile(story.id);
  return { t, id: story.id };
}
const planOf = (t: ReturnType<typeof serviceSetup>, id: string) => JSON.parse(readFileSync(join(t.service.storyDir(id), 'assemble.json'), 'utf8'));

describe('StoryService + dubbing', () => {
  it('the assembly plan carries the fresh dub of each shot and the ambient choice; shots without a dub are untouched', async () => {
    const { t, id } = await ready({ dub: { for: async () => ({ keepAmbient: true, shots: { '01-a': { file: '/data/dub/01-a-abc.mp3', seconds: 2.5 } } }) } });
    await t.service.assemble(id);
    const plan = planOf(t, id);
    expect(plan.shots[0].dub).toEqual({ file: '/data/dub/01-a-abc.mp3', seconds: 2.5 });
    expect(plan.shots[1].dub).toBeUndefined();
    expect(plan.edit.dubKeepAmbient).toBe(true);
  });

  it('with no dub at all the plan is exactly what it was (no dub keys, no edit block invented)', async () => {
    const { t, id } = await ready({ dub: { for: async () => ({ keepAmbient: false, shots: {} }) } });
    await t.service.assemble(id);
    const plan = planOf(t, id);
    expect(JSON.stringify(plan)).not.toContain('dub');
    expect(plan.edit).toBeUndefined();
    const plain = await ready();
    await plain.t.service.assemble(plain.id);
    expect(JSON.stringify(planOf(plain.t, plain.id))).not.toContain('dub');
  });

  it('markVideoStale: a finished video becomes "assemble again"; asking twice or with no video changes nothing', async () => {
    const t0 = serviceSetup();
    const none = await t0.service.create(board());
    await t0.service.markVideoStale(none.id); // no video yet
    expect((await t0.service.get(none.id))!.videoStale).toBeFalsy();
    const { t, id } = await ready(); // every clip done: the first cut is made by reconcile
    expect((await t.service.get(id))!.status).toBe('done');
    await t.service.markVideoStale(id);
    const stale = (await t.service.get(id))!;
    expect(stale).toMatchObject({ videoStale: true, status: 'review' });
    const rev = stale.rev;
    await t.service.markVideoStale(id);
    expect((await t.service.get(id))!.rev).toBe(rev);
  });

  it('the assembler is told who owns the story (fair queueing) and can report its place in line', async () => {
    const calls: Array<{ owner?: string; hasPosition: boolean }> = [];
    const { t, id } = await ready({
      assemble: async (dir, ctx) => { calls.push({ ...(ctx?.owner ? { owner: ctx.owner } : {}), hasPosition: typeof ctx?.onPosition === 'function' }); writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); }
    }, 'u_alice');
    await t.service.assemble(id);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every(c => c.owner === 'u_alice' && c.hasPosition)).toBe(true);
  });

  it('waiting in the assembly queue is written to the activity log, so the user sees "antre #n" instead of a frozen page', async () => {
    const { t, id } = await ready({
      assemble: async (dir, ctx) => { ctx?.onPosition?.(3, 5); ctx?.onPosition?.(1, 2); writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); }
    });
    await t.service.assemble(id);
    const messages = (await t.service.get(id))!.events.map(e => e.message);
    expect(messages.some(m => /antre.*3.*5/i.test(m))).toBe(true);
    expect(messages.at(-1)).toBe('Video selesai');
  });

  it('startAssembly returns at once with the story "assembling" and finishes in the background', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let armed = false; // reconcile already assembled once while the story was being set up
    const { t, id } = await ready({ assemble: async dir => { if (armed) await gate; writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); } });
    armed = true;
    const started = await t.service.startAssembly(id);
    expect(started.status).toBe('assembling');
    await expect(t.service.startAssembly(id)).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await t.service.settle(id);
    expect((await t.service.get(id))!).toMatchObject({ status: 'done' });
  });

  it('a background assembly that fails ends as failed with the reason, and the previous video stays', async () => {
    let fail = false;
    const { t, id } = await ready({ assemble: async dir => { if (fail) throw new Error('ffmpeg was killed (SIGKILL): out of memory'); writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); } });
    await t.service.assemble(id);
    await t.service.markVideoStale(id);
    fail = true;
    await t.service.startAssembly(id);
    await t.service.settle(id);
    const after = (await t.service.get(id))!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/out of memory/);
    expect(after.video).toBeTruthy();
  });
});

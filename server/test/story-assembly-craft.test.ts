import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editPrint, hashFor, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { finishQueued, serviceSetup } from './bible-board.js';

const board = (): Storyboard => ({
  title: 'Dua Pasang Jejak',
  characters: { RAKA: 'a boy in a red hoodie' },
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '01-a', prompt: 'Medium shot, RAKA prays.', narration: 'Setiap malam Raka berdoa.' },
    { id: '02-b', prompt: 'Wide shot, RAKA on the beach.', narration: 'Dia tidak pernah pergi.' }
  ]
});
const errors = (patch: (b: Storyboard) => void) => { const b = board(); patch(b); return validateStoryboard(b).join('; '); };

async function assembled() {
  const t = serviceSetup();
  const story = await t.service.create(board());
  await t.service.render(story.id, { force: true });
  await finishQueued(t, 'video');
  await t.service.reconcile(story.id);
  await t.service.assemble(story.id);
  expect((await t.service.get(story.id))!.status).toBe('done');
  return { t, id: story.id };
}
const planOf = (t: Awaited<ReturnType<typeof assembled>>['t'], id: string) => JSON.parse(readFileSync(join(t.service.storyDir(id), 'assemble.json'), 'utf8'));

describe('E2 edit.fadeIn: validation', () => {
  it('accepts 0 to 1.2 seconds and nothing else', () => {
    for (const v of [0, 0.25, 0.8, 1.2]) expect(errors(b => { b.edit = { fadeIn: v }; })).toBe('');
    for (const v of [-0.1, 1.21, 5]) expect(errors(b => { b.edit = { fadeIn: v }; })).toMatch(/edit\.fadeIn/);
    for (const v of ['cepat', true, null, [0.5], {}]) expect(errors(b => { b.edit = { fadeIn: v } as unknown as Storyboard['edit']; })).toMatch(/edit\.fadeIn/);
  });
});

describe('E2 edit.fadeIn: assembly only', () => {
  it('never touches a clip hash', () => {
    const b = board();
    const edited = { ...b, edit: { fadeIn: 0.25 } };
    for (let i = 0; i < b.shots.length; i++) expect(hashFor(edited, edited.shots[i]!)).toBe(hashFor(b, b.shots[i]!));
  });

  it('editPrint changes (the video is stale) when the fade changes, and not for the value it already had', () => {
    const b = board();
    expect(editPrint({ ...b, edit: { fadeIn: 0.25 } })).not.toBe(editPrint(b));
    expect(editPrint({ ...b, edit: { fadeIn: 0 } })).not.toBe(editPrint(b));
    expect(editPrint({ ...b, edit: { fadeIn: 0.25 } })).not.toBe(editPrint({ ...b, edit: { fadeIn: 0.5 } }));
    // 0.8 is what an absent field already means: saying it out loud must not stale a finished video
    expect(editPrint({ ...b, edit: { fadeIn: 0.8 } })).toBe(editPrint(b));
  });

  it('an old board prints exactly what it printed before the field existed', () => {
    const b = board();
    expect(editPrint(b)).toBe(JSON.stringify({ e: null, s: [['01-a', null, null], ['02-b', null, null]] }));
    expect(editPrint({ ...b, edit: { subtitles: true, clipVolume: 0.7 } })).toBe(JSON.stringify({ e: { subtitles: true, clipVolume: 0.7 }, s: [['01-a', null, 'Setiap malam Raka berdoa.'], ['02-b', null, 'Dia tidak pernah pergi.']] }));
  });

  it('changing the fade marks a finished video stale, keeps every paid clip, and reaches the plan', async () => {
    const { t, id } = await assembled();
    const before = (await t.service.get(id))!.shots.map(s => [s.id, s.status, s.jobId]);
    const b = await t.service.readStoryboard(id);
    b.edit = { fadeIn: 0.25 };
    const after = await t.service.updateStoryboard(id, b);
    expect(after.videoStale).toBe(true);
    expect(after.shots.map(s => [s.id, s.status, s.jobId])).toEqual(before);
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({ fadeIn: 0.25 });
  });

  it('an old plan says nothing about the fade', async () => {
    const { t, id } = await assembled();
    expect(planOf(t, id).edit).toBeUndefined();
    const b = await t.service.readStoryboard(id);
    b.edit = { subtitles: true };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({ subtitles: true });
  });

  it('fadeIn 0 reaches the plan (a zero is a choice, not "absent")', async () => {
    const { t, id } = await assembled();
    const b = await t.service.readStoryboard(id);
    b.edit = { fadeIn: 0 };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({ fadeIn: 0 });
  });
});

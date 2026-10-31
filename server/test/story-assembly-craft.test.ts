import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XFADE_TRANSITIONS, editPrint, hashFor, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
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

describe('E3 edit.beatCuts: validation', () => {
  it('is off when absent or false; { } turns it on; zoom is 1.05 to 1.3', () => {
    for (const v of [undefined, false, {}, { zoom: 1.14 }, { zoom: 1.05 }, { zoom: 1.3 }]) expect(errors(b => { b.edit = { beatCuts: v } as Storyboard['edit']; })).toBe('');
    for (const v of [true, 'ya', 3, null, [], [1], { zoom: 1.04 }, { zoom: 1.31 }, { zoom: 'x' }, { zoom: null }, { zoom: true }]) {
      expect(errors(b => { b.edit = { beatCuts: v } as unknown as Storyboard['edit']; })).toMatch(/edit\.beatCuts/);
    }
  });
});

describe('E3 edit.beatCuts: assembly only', () => {
  it('never touches a clip hash', () => {
    const b = board();
    const edited = { ...b, edit: { beatCuts: { zoom: 1.2 } } };
    for (let i = 0; i < b.shots.length; i++) expect(hashFor(edited, edited.shots[i]!)).toBe(hashFor(b, b.shots[i]!));
  });

  it('editPrint changes when beat cuts are turned on or tuned, and false means what absent means', () => {
    const b = board();
    expect(editPrint({ ...b, edit: { beatCuts: {} } })).not.toBe(editPrint(b));
    expect(editPrint({ ...b, edit: { beatCuts: { zoom: 1.2 } } })).not.toBe(editPrint({ ...b, edit: { beatCuts: {} } }));
    expect(editPrint({ ...b, edit: { beatCuts: false } })).toBe(editPrint(b));
    expect(editPrint({ ...b, edit: { subtitles: true, beatCuts: false } })).toBe(editPrint({ ...b, edit: { subtitles: true } }));
  });

  it('turning it on marks a finished video stale, keeps every paid clip, and reaches the plan; off leaves the plan silent', async () => {
    const { t, id } = await assembled();
    const before = (await t.service.get(id))!.shots.map(s => [s.id, s.status, s.jobId]);
    const b = await t.service.readStoryboard(id);
    b.edit = { beatCuts: { zoom: 1.2 } };
    const after = await t.service.updateStoryboard(id, b);
    expect(after.videoStale).toBe(true);
    expect(after.shots.map(s => [s.id, s.status, s.jobId])).toEqual(before);
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({ beatCuts: { zoom: 1.2 } });
    b.edit = { beatCuts: {} };
    await t.service.updateStoryboard(id, b);
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({ beatCuts: {} });
    b.edit = { beatCuts: false };
    expect((await t.service.updateStoryboard(id, b)).videoStale).toBe(true);   // it was on a moment ago
    await t.service.assemble(id);
    expect(planOf(t, id).edit).toEqual({});
  });
});

describe('E4 shot.transition: only the xfade names we allow reach ffmpeg', () => {
  const withTransition = (t: unknown) => errors(b => { (b.shots[1] as { transition?: unknown }).transition = t; });

  it('accepts no transition and every allowed name', () => {
    expect(errors(() => undefined)).toBe('');
    for (const name of ['fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'slideup', 'circleopen', 'pixelize', 'zoomin']) expect(withTransition(name)).toBe('');
    for (const name of XFADE_TRANSITIONS) expect(withTransition(name)).toBe('');
  });

  it('refuses anything that is not a plain allowed name — including text that would add ffmpeg filters', () => {
    for (const bad of [
      'fade;[0:v]movie=/etc/passwd[x]', 'fade:duration=0', 'fade,scale=1:1', 'fade\n', ' fade', 'FADE', 'Fade', '', 'custom', "fade'", 'fade[x]', 'fade=1',
      'nonexistent', 'fade;', '../fade', 'a'.repeat(5000), 123, null, true, ['fade'], { a: 1 }
    ]) expect(withTransition(bad), JSON.stringify(bad)).toMatch(/02-b: transition/);
  });

  it('the injection from the audit (PoC 4.5) no longer passes validation', () => {
    expect(withTransition('fade:duration=0.3:offset=0,sendcmd=f=/etc/hostname,xfade=transition=fade')).toMatch(/transition/);
  });

  it('the list in the validator is the list the assembler guards with', () => {
    const py = readFileSync(join(__dirname, '../../bridge/py/assemble.py'), 'utf8');
    const block = /XFADE_TRANSITIONS\s*=\s*frozenset\(\s*'''([\s\S]*?)'''\.split\(\)\s*\)/.exec(py);
    expect(block, 'XFADE_TRANSITIONS in assemble.py').toBeTruthy();
    expect([...XFADE_TRANSITIONS].sort()).toEqual(block![1]!.split(/\s+/).filter(Boolean).sort());
  });
});

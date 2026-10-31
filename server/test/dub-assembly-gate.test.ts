import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../src/stories/storyboard.js';
import { finishQueued, serviceSetup } from './bible-board.js';

const board = (): Storyboard => ({
  title: 'Dub', mode: 'cepat', aspect: '9:16',
  shots: [{ id: '01-a', prompt: 'Medium shot. A girl waits.', narration: 'Aku menunggu.' }, { id: '02-b', prompt: 'Close-up. She smiles.', narration: 'Lalu tersenyum.' }]
});
type Dub = NonNullable<Parameters<typeof serviceSetup>[0]['dub']>;
const file = (id: string) => ({ file: `/data/dub/${id}-abc.mp3`, seconds: 2.5 });

async function ready(dubFor: () => ReturnType<Dub['for']>) {
  const t = serviceSetup({ dub: { for: dubFor } });
  const story = await t.service.create(board());
  await t.service.render(story.id, { force: true });
  await finishQueued(t, 'video');
  await t.service.reconcile(story.id);
  await t.service.settle(story.id);
  return { t, id: story.id };
}

describe('S8: assembling with text that has no fresh dub warns (the shot would be silent)', () => {
  it('startAssembly answers with warnings [dub-basi:<shot>], keeps them on the story, and still assembles', async () => {
    let stale: string[] = ['02-b'];
    const { t, id } = await ready(async () => ({ keepAmbient: false, shots: { '01-a': file('01-a') }, staleShots: stale }));
    const started = await t.service.startAssembly(id);
    expect(started.warnings).toEqual(['dub-basi:02-b']);
    await t.service.settle(id);
    const done = (await t.service.get(id))!;
    expect(done.status).toBe('done');
    expect(done.warnings).toEqual(['dub-basi:02-b']);
    // the warning is for the human, not for the assembler
    const plan = readFileSync(join(t.service.storyDir(id), 'assemble.json'), 'utf8');
    expect(plan).not.toContain('dub-basi');
    expect(plan).not.toContain('staleShots');
    // fixed → the next assembly clears it
    stale = [];
    const again = await t.service.startAssembly(id);
    expect(again.warnings).toBeUndefined();
    await t.service.settle(id);
    expect((await t.service.get(id))!.warnings).toBeUndefined();
  });

  it('assemble() (waits for the video) carries the same warnings; several shots are listed in order', async () => {
    const { t, id } = await ready(async () => ({ keepAmbient: false, shots: { '01-a': file('01-a') }, staleShots: ['02-b', '01-a'] }));
    const done = await t.service.assemble(id);
    expect(done.warnings).toEqual(['dub-basi:02-b', 'dub-basi:01-a']);
  });

  it('a project without dubbing (or an older dub provider that does not report stale shots) gets no warning at all', async () => {
    const none = await ready(async () => ({ keepAmbient: false, shots: {}, staleShots: [] }));
    expect((await none.t.service.assemble(none.id)).warnings).toBeUndefined();
    const old = await ready(async () => ({ keepAmbient: false, shots: { '01-a': file('01-a') } }) as never);
    expect((await old.t.service.assemble(old.id)).warnings).toBeUndefined();
    const plain = serviceSetup();
    const story = await plain.service.create(board());
    expect((await plain.service.get(story.id))!.warnings).toBeUndefined();
  });
});

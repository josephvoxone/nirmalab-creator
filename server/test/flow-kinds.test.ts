import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';

const store = () => new FlowStore(mkdtempSync(join(tmpdir(), 'flow-kinds-')));

describe('FlowStore job kinds and story affinity', () => {
  it('stores kind, characters, startFrame and group on the job; defaults to video', async () => {
    const s = store();
    const plain = await s.createJob({ prompt: 'ombak', durationSec: 6 });
    expect(plain.kind).toBe('video');
    const frame = await s.createJob({
      prompt: 'Laras on a porch', kind: 'image', group: 'story_0123456789abcdef',
      characters: [{ name: 'Laras', look: 'girl with two braids' }]
    });
    expect(frame).toMatchObject({ kind: 'image', group: 'story_0123456789abcdef', characters: [{ name: 'Laras', look: 'girl with two braids' }] });
    const vid = await s.createJob({ prompt: 'push in', kind: 'video', startFrame: { mediaId: 'm1', caption: 'Girl on porch' } });
    expect(vid.startFrame).toEqual({ mediaId: 'm1', caption: 'Girl on porch' });
  });

  it('pins every job of a group to the account that took the first one', async () => {
    const s = store();
    const a = await s.addAccount({ label: 'A', email: 'a@x.io' });
    const b = await s.addAccount({ label: 'B', email: 'b@x.io' });
    await s.createJob({ prompt: '1', kind: 'character', group: 'g1' });
    await s.createJob({ prompt: '2', kind: 'image', group: 'g1' });
    await s.createJob({ prompt: '3', kind: 'image', group: 'g1' });
    const first = await s.claimJob('mac');
    const second = await s.claimJob('mac');
    const third = await s.claimJob('mac');
    expect(new Set([first!.accountId, second!.accountId, third!.accountId]).size).toBe(1);
    expect([a.id, b.id]).toContain(first!.accountId);
  });

  it('a pinned group waits for its account instead of moving to another one', async () => {
    const s = store();
    const a = await s.addAccount({ label: 'A', email: 'a@x.io' });
    await s.createJob({ prompt: '1', kind: 'character', group: 'g1' });
    const first = await s.claimJob('mac');
    expect(first!.accountId).toBe(a.id);
    await s.addAccount({ label: 'B', email: 'b@x.io' });
    await s.coolDown(a.id, 60_000);
    await s.createJob({ prompt: '2', kind: 'image', group: 'g1' });
    await s.createJob({ prompt: 'other', kind: 'video' });
    const next = await s.claimJob('mac');
    expect(next!.prompt).toBe('other');
    expect(await s.claimJob('mac')).toBeUndefined();
  });

  it('completeJob keeps the Flow result ids', async () => {
    const s = store();
    await s.addAccount({ label: 'A', email: 'a@x.io' });
    const job = await s.createJob({ prompt: 'p', kind: 'image', group: 'g' });
    await s.claimJob('mac');
    const done = await s.completeJob(job.id, { filePath: '/x.png', bytes: 5, result: { mediaId: 'm9', caption: 'Girl on hill' } });
    expect(done!.result).toEqual({ mediaId: 'm9', caption: 'Girl on hill' });
  });
});

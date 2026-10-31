import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { StoryError, StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const board = (title: string): Storyboard => ({
  title,
  characters: {},
  audio: 'Audio: "{line}"',
  audioSilent: 'Audio: wind.',
  shots: [{ id: '00-a', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' }]
});

function setup(legacyOwnerId?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-owner-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(8, 1)); }, ...(legacyOwnerId ? { legacyOwnerId: () => legacyOwnerId } : {}) });
  return { dataDir, service };
}

describe('T1 StoryService owner API (additive)', () => {
  it('ownerOf reads createdBy; unknown ids and ownerless projects have none', async () => {
    const { service } = setup();
    const mine = await service.create(board('Punya Joseph'), { createdBy: 'u_joseph' });
    const loose = await service.create(board('Tanpa pemilik'));
    expect(await service.ownerOf(mine.id)).toBe('u_joseph');
    expect(await service.ownerOf(loose.id)).toBeUndefined();
    expect(await service.ownerOf('story_0000000000000000')).toBeUndefined();
    expect(await service.ownerOf('../etc/passwd')).toBeUndefined();
  });

  it('assertOwner returns the record for the owner; anyone else gets the SAME NOT_FOUND as for a missing project', async () => {
    const { service } = setup();
    const mine = await service.create(board('Punya Joseph'), { createdBy: 'u_joseph' });
    expect((await service.assertOwner(mine.id, 'u_joseph')).id).toBe(mine.id);
    const other = await service.assertOwner(mine.id, 'u_bob').catch(e => e);
    const missing = await service.assertOwner('story_0000000000000000', 'u_bob').catch(e => e);
    expect(other).toBeInstanceOf(StoryError);
    expect((other as StoryError).code).toBe('NOT_FOUND');
    expect((missing as StoryError).code).toBe('NOT_FOUND');
    expect((other as StoryError).message).toBe((missing as StoryError).message);
    // an empty user id never matches an ownerless project (undefined !== '')
    const loose = await service.create(board('Tanpa pemilik'));
    await expect(service.assertOwner(loose.id, '')).rejects.toBeInstanceOf(StoryError);
    await expect(service.assertOwner(loose.id, 'u_joseph')).rejects.toBeInstanceOf(StoryError);
  });

  it('listFor returns only that user\'s projects, newest first; the unbounded list() is unchanged', async () => {
    const { service } = setup();
    const a = await service.create(board('A'), { createdBy: 'u_joseph' });
    await new Promise(r => setTimeout(r, 5));
    const b = await service.create(board('B'), { createdBy: 'u_bob' });
    await new Promise(r => setTimeout(r, 5));
    const c = await service.create(board('C'), { createdBy: 'u_joseph' });
    const loose = await service.create(board('D'));
    expect((await service.listFor('u_joseph')).map(r => r.id)).toEqual([c.id, a.id]);
    expect((await service.listFor('u_bob')).map(r => r.id)).toEqual([b.id]);
    expect(await service.listFor('u_nobody')).toEqual([]);
    expect(await service.listFor('')).toEqual([]);
    expect((await service.list()).map(r => r.id).sort()).toEqual([a.id, b.id, c.id, loose.id].sort());
  });
});

describe('T3 legacy owner: a project that never got an owner belongs to the main owner (Joseph keeps his), nobody else', () => {
  it('ownerOf / assertOwner / listFor: an ownerless project is the legacy owner\'s only; a project whose creator account is gone is nobody\'s', async () => {
    const { service } = setup('u_joseph');
    const loose = await service.create(board('Lama, tanpa pemilik'));
    const dangling = await service.create(board('Pembuatnya sudah dihapus'), { createdBy: 'u_deleted' });
    expect(await service.ownerOf(loose.id)).toBe('u_joseph');
    expect((await service.assertOwner(loose.id, 'u_joseph')).id).toBe(loose.id);
    await expect(service.assertOwner(loose.id, 'u_bob')).rejects.toBeInstanceOf(StoryError);
    expect((await service.listFor('u_joseph')).map(r => r.id)).toEqual([loose.id]);
    expect(await service.listFor('u_bob')).toEqual([]);
    expect(await service.ownerOf(dangling.id)).toBe('u_deleted');
    await expect(service.assertOwner(dangling.id, 'u_joseph')).rejects.toBeInstanceOf(StoryError);
    expect((await service.listFor('u_joseph')).map(r => r.id)).not.toContain(dangling.id);
  });

  it('without a legacy owner configured the old behaviour holds (ownerless = nobody\'s)', async () => {
    const { service } = setup();
    const loose = await service.create(board('Tanpa pemilik'));
    expect(await service.ownerOf(loose.id)).toBeUndefined();
    await expect(service.assertOwner(loose.id, 'u_joseph')).rejects.toBeInstanceOf(StoryError);
  });
});

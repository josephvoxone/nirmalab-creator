/** Shared fixtures: a small bible board (same shape as bible-integration.test.ts) and a fake-Flow service. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoryBible } from '../src/bible/story.js';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

export const bible = (): StoryBible => ({
  logline: 'Seorang gadis penjual ikan menyembunyikan kelinci putih dari pasar yang lapar.',
  theme: 'Keberanian kecil menolong yang lemah',
  tone: 'hangat dan tenang',
  audience: 'anak',
  structure: [
    { act: 'hook', goal: 'menarik perhatian', beat: 'pasar ramai saat subuh' },
    { act: 'payoff', goal: 'menutup cerita', beat: 'Laras menemukan kelinci' }
  ],
  characters: [
    { token: 'LARAS', name: 'Laras', anchors: ['two black braids', 'a faded blue school uniform'], want: 'menjual semua ikan', need: 'keberanian menolong', arc: 'ragu menjadi berani' },
    { token: 'KAPAS', name: 'Kapas', anchors: ['a cream rabbit with one floppy ear'], want: 'kembali ke hutan', need: 'percaya pada Laras', arc: 'takut menjadi percaya' }
  ],
  locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a busy fish market at dawn with wet stone floors' }],
  scenes: [{ id: 'pasar', title: 'Di Pasar', goal: 'Laras menyembunyikan Kapas dari pembeli', location: 'PASAR_IKAN' }],
  rules: { maxShotSec: 6, narrationMaxWords: 12 }
});

export const bibleBoard = (): Storyboard => ({
  title: 'Pasar Pagi',
  mode: 'cepat',
  aspect: '9:16',
  look: { family: 'film-real', variant: 'cinematic-drama' },
  characters: { LARAS: 'a girl with two black braids', KAPAS: { name: 'Kapas', look: 'a cream rabbit with a red scarf' } },
  locations: { PASAR_IKAN: { name: 'Pasar Ikan', look: 'a busy fish market at dawn with wet stone floors' } },
  scenes: [{ id: 'pasar', title: 'Di Pasar', location: 'PASAR_IKAN', shots: ['01-laras', '02-kapas'] }],
  bible: bible(),
  shots: [
    { id: '01-laras', prompt: 'Medium shot, the camera stays still. LARAS waits behind the fish stall at dawn.', narration: 'Laras pergi ke pasar pagi itu.', intent: { subject: 'LARAS', action: 'stands still behind the fish stall', startState: 'her hands are empty', endState: 'her hands close around a hidden basket', framing: 'medium', move: 'static', emotion: 'waspada' } },
    { id: '02-kapas', prompt: 'Medium close-up, the camera pushes in slowly. LARAS lifts the woven basket off the wet stones.', narration: 'Kapas menunggu di keranjang.', intent: { subject: 'LARAS', action: 'lifts the woven basket off the wet stones', startState: 'the basket is hidden under the table', endState: 'the basket is held against her chest', framing: 'medium-close', move: 'push-in', emotion: 'takut ketahuan' } }
  ]
});

export function serviceSetup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-rev-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); }
  });
  return { dataDir, flow, service };
}

let fill = 1;
/** The bridge finishes every queued job of a kind; each clip gets distinct bytes. */
export async function finishQueued(t: ReturnType<typeof serviceSetup>, kind: FlowJob['kind']) {
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
    const file = join(dir, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
    writeFileSync(file, Buffer.alloc(20_000, (fill++ % 250) + 1));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: { mediaId: `m-${job.id}`, caption: `cap ${job.id}` } });
  }
}

/** A cepat story with every clip rendered and paid for. */
export async function renderedStory(t: ReturnType<typeof serviceSetup>, board: Storyboard) {
  const story = await t.service.create(board);
  await t.service.render(story.id, { force: true });
  await finishQueued(t, 'video');
  await t.service.reconcile(story.id);
  return (await t.service.get(story.id))!;
}

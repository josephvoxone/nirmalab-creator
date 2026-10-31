/** Shared fake deps for the dub money / fit tests: nothing here talks to ElevenLabs. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DubService, type DubDeps } from '../src/dub/service.js';
import type { SynthesizeInput } from '../src/dub/elevenlabs.js';
import { FairQueue } from '../src/lib/fair-queue.js';
import type { Storyboard } from '../src/stories/storyboard.js';

export const ID = 'story_aaaaaaaaaaaaaaaa';

export const defaultBoard = (): Storyboard => ({
  title: 'Lentera',
  scenes: [{ id: 'jalan', title: 'Jalan', shots: ['s1', 's2'] }],
  shots: [
    { id: 's1', prompt: 'p1', narration: 'Aku mau yang indah.' },
    { id: 's2', prompt: 'p2', narration: 'Tapi tangan itu membelokkanku.' }
  ]
} as Storyboard);

export type HarnessOptions = {
  board?: Storyboard; delayMs?: number; concurrency?: number; configured?: boolean;
  balance?: () => Promise<number | undefined>;
  clipSeconds?: (id: string) => Promise<Record<string, number>>;
  fail?: (input: SynthesizeInput) => Error | undefined;
  /** Quota ledger handed to the service (T5b). */
  quota?: DubDeps['quota'];
  /** The provider call never returns (a process that dies mid-dub). */
  hang?: boolean;
  /** Directory of the stories (to run a second service on the same files after a "restart"). */
  dir?: string;
};

export function makeHarness(options: HarnessOptions = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'dubh-'));
  const calls: SynthesizeInput[] = [];
  const stale: string[] = [];
  const current = { board: options.board ?? defaultBoard() };
  const deps: DubDeps = {
    dir: id => join(dir, id),
    board: async () => current.board,
    markStale: async id => { stale.push(id); },
    client: {
      configured: () => options.configured ?? true,
      synthesize: async input => {
        calls.push(input); // counted when the call STARTS: that is when the provider bills
        if (options.hang) await new Promise<never>(() => undefined);
        await new Promise(r => setTimeout(r, options.delayMs ?? 15));
        const err = options.fail?.(input);
        if (err) throw err;
        return { audio: Buffer.from(`MP3:${input.text}:${input.voiceId}`), keyId: 'k1' };
      },
      ...(options.balance ? { balance: options.balance } : {})
    },
    queue: new FairQueue({ concurrency: options.concurrency ?? 6 }),
    probe: async () => 3.2,
    ...(options.clipSeconds ? { clipSeconds: options.clipSeconds } : {}),
    ...(options.quota ? { quota: options.quota } : {})
  };
  const svc = new DubService(deps);
  return { svc, calls, stale, dir, current, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export type Harness = ReturnType<typeof makeHarness>;
export const creditsFor = async (h: Harness, scope: Parameters<Harness['svc']['plan']>[1], opts: { force?: boolean } = {}) => (await h.svc.plan(ID, scope, opts)).credits;

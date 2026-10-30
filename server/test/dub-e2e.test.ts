/**
 * Dubbing end to end across the TypeScript/Python boundary: DubService renders (ElevenLabs stand-in returning a REAL mp3),
 * its plan goes to the real assembler (ffmpeg + python), and the sound of the final file is measured: the dub's tone is
 * there, the clip's own tone is gone (or only quiet when "suasana" is kept), and a shot without a dub keeps its own sound.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DubService } from '../src/dub/service.js';
import { FairQueue } from '../src/lib/fair-queue.js';
import { assembleStory, probeClip } from '../src/stories/media.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const PY = process.env.STORY_PYTHON ?? 'python3';
const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync(PY, ['-c', 'import PIL, numpy']).status === 0;
const root = mkdtempSync(join(tmpdir(), 'nc-dub-e2e-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CLIP_HZ = 440, DUB_HZ = 1320;
function clip(file: string, seconds: number) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=720x1280:r=24:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${CLIP_HZ}:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}
const tone = (seconds: number) => {
  const out = join(root, `tone-${seconds}.mp3`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${DUB_HZ}:duration=${seconds}`, '-c:a', 'libmp3lame', out]);
  return readFileSync(out);
};
/** Share of the energy of [from, to) seconds that sits at each frequency, measured on the final file. */
function energy(file: string, from: number, to: number, hz: number[]): number[] {
  const script = `
import subprocess, sys, numpy as np
f, a, b = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
pcm = subprocess.run(['ffmpeg','-v','error','-i',f,'-ss',str(a),'-t',str(b-a),'-vn','-ac','1','-ar','16000','-f','s16le','-'], capture_output=True).stdout
x = np.frombuffer(pcm, dtype=np.int16).astype(float)
spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
freqs = np.fft.rfftfreq(len(x), 1/16000)
print(' '.join(str(float(spec[(freqs > h - 25) & (freqs < h + 25)].sum())) for h in map(float, sys.argv[4:])))`;
  return execFileSync(PY, ['-c', script, file, String(from), String(to), ...hz.map(String)]).toString().trim().split(' ').map(Number);
}

describe.skipIf(!hasTools)('dubbing → real assembler', () => {
  async function run(keepAmbient: boolean) {
    const dir = join(root, `story-${keepAmbient ? 'ambient' : 'mute'}`);
    execFileSync('mkdir', ['-p', dir]);
    for (const id of ['a', 'b', 'c']) clip(join(dir, `${id}.mp4`), 4);
    const board = { title: 'Uji', shots: [{ id: 'a', prompt: 'p', narration: 'Satu dua tiga.' }, { id: 'b', prompt: 'p', narration: 'Empat lima enam.' }, { id: 'c', prompt: 'p', silent: true }] } as Storyboard;
    let rendered = 0;
    const svc = new DubService({
      dir: () => dir, board: async () => board, markStale: async () => undefined,
      client: { configured: () => true, synthesize: async () => { rendered++; return { audio: tone(2), keyId: 'k' }; } },
      queue: new FairQueue({ concurrency: 2 }),
      probe: async f => (await probeClip(f)).durationSec
    });
    await svc.updateSettings('s', { voiceId: 'VOICE_TEST', keepAmbient });
    const plan = await svc.plan('s', { kind: 'all' });
    await svc.render('s', { kind: 'all' }, { owner: 'u', confirmCredits: plan.credits });
    await svc.idle('s');
    const dubs = await svc.dubFor('s');
    writeFileSync(join(dir, 'assemble.json'), JSON.stringify({
      title: 'Uji', slug: 'final', crossfade: 0.3,
      shots: board.shots.map(s => ({ id: s.id, ...(dubs.shots[s.id] ? { dub: dubs.shots[s.id] } : {}) })),
      ...(dubs.keepAmbient ? { edit: { dubKeepAmbient: true } } : {})
    }));
    await assembleStory(dir);
    return { final: join(dir, 'final.mp4'), rendered, dubbed: Object.keys(dubs.shots) };
  }

  it('the dubbed shots speak with the dub, the silent one keeps its own clip sound, the clip sound under a dub is gone', async () => {
    const r = await run(false);
    expect(r.rendered).toBe(2); // two shots with narration; the silent one costs nothing
    expect(r.dubbed).toEqual(['a', 'b']);
    // shot a plays 0..4 s: dub starts after the crossfade lead; shot c (silent) plays ~7.4..11.4 s
    const [clipA, dubA] = energy(r.final, 0.6, 3.0, [CLIP_HZ, DUB_HZ]);
    expect(dubA!).toBeGreaterThan(clipA! * 50);
    const [clipC, dubC] = energy(r.final, 8, 11, [CLIP_HZ, DUB_HZ]);
    expect(clipC!).toBeGreaterThan(dubC! * 50);
    expect((await probeClip(r.final)).hasAudio).toBe(true);
  }, 240_000);

  it('"suasana diredam" keeps the clip sound quiet under the voice instead of removing it', async () => {
    const muted = await run(false);
    const kept = await run(true);
    const [mClip] = energy(muted.final, 0.6, 3.0, [CLIP_HZ]);
    const [kClip, kDub] = energy(kept.final, 0.6, 3.0, [CLIP_HZ, DUB_HZ]);
    expect(kClip!).toBeGreaterThan(mClip! * 20); // audible again
    expect(kDub!).toBeGreaterThan(kClip! * 5);   // but far below the voice
  }, 240_000);
});

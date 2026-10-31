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

  it('the voice\'s word timings travel service → assemble.json → libass: three words at a time, only the word being spoken lit', async () => {
    const dir = join(root, 'story-karaoke');
    execFileSync('mkdir', ['-p', dir]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:r=24:d=6', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'a.mp4')]);
    const board = { title: 'Uji', shots: [{ id: 'a', prompt: 'p', narration: 'satu dua tiga empat.' }] } as Storyboard;
    const svc = new DubService({
      dir: () => dir, board: async () => board, markStale: async () => undefined,
      client: { configured: () => true, synthesize: async () => ({ audio: tone(3), keyId: 'k', words: [['satu', 0, 0.6], ['dua', 0.7, 1.3], ['tiga', 1.4, 2.0], ['empat.', 2.1, 2.7]] as [string, number, number][] }) },
      queue: new FairQueue({ concurrency: 1 }),
      probe: async f => (await probeClip(f)).durationSec
    });
    await svc.updateSettings('s', { voiceId: 'VOICE_TEST' });
    const plan = await svc.plan('s', { kind: 'all' });
    await svc.render('s', { kind: 'all' }, { owner: 'u', confirmCredits: plan.credits });
    await svc.idle('s');
    const dubs = await svc.dubFor('s');
    const planFile = (karaoke: boolean) => writeFileSync(join(dir, 'assemble.json'), JSON.stringify({
      title: 'Uji', slug: 'final', crossfade: 0.3,
      shots: [{ id: 'a', narration: 'satu dua tiga empat.', dub: dubs.shots.a }],
      edit: { subtitles: true, subtitleStyle: 'tulisan-tangan', subtitleSize: 1.2, ...(karaoke ? {} : { subtitleKaraoke: false }) }
    }));
    // [amber pixel count, mean x of the amber] of the frame at second t
    const amber = (file: string, t: number): [number, number] => JSON.parse(execFileSync(PY, ['-c', `
import subprocess, sys, json
from PIL import Image
f, t = sys.argv[1], sys.argv[2]
subprocess.run(['ffmpeg','-v','error','-y','-ss',t,'-i',f,'-frames:v','1',f+'.png'], check=True)
im = Image.open(f+'.png').convert('RGB'); w = im.size[0]
xs = [i % w for i, (r,g,b) in enumerate(im.getdata()) if r > 230 and 170 < g < 215 and b < 120]
print(json.dumps([len(xs), sum(xs)/len(xs) if xs else 0]))`, file, String(t)]).toString().trim());
    planFile(true);
    await assembleStory(dir);
    const final = join(dir, 'final.mp4');
    // words: satu .3-.9 | dua 1.0-1.6 || tiga 1.7-2.3 | empat. 2.4-3.0 on the film's clock → two cues of two words
    expect(amber(final, 0.05)[0]).toBe(0);
    expect(amber(final, 1.3)[0]).toBeGreaterThan(100);                 // 'dua' is lit
    const tiga = amber(final, 2.0), empat = amber(final, 2.7);
    expect(tiga[0]).toBeGreaterThan(100);
    expect(empat[0]).toBeGreaterThan(100);
    expect(empat[1]).toBeGreaterThan(tiga[1] + 40);                   // the light moves right, word by word, inside the second cue
    expect(Math.max(tiga[0], empat[0])).toBeLessThan(1.8 * Math.min(tiga[0], empat[0]));   // one word at a time: it does not pile up
    expect(amber(final, 3.7)[0]).toBe(0);                             // and once the words are spoken the caption is gone
    planFile(false);                        // "Sorot kata" off: the same words, plain caption, nothing is ever gold
    await assembleStory(dir);
    expect([1.3, 2.0, 2.7].map(t => amber(final, t)[0])).toEqual([0, 0, 0]);
  }, 240_000);

  it('\"suasana diredam\" keeps the clip sound quiet under the voice instead of removing it', async () => {
    const muted = await run(false);
    const kept = await run(true);
    const [mClip] = energy(muted.final, 0.6, 3.0, [CLIP_HZ]);
    const [kClip, kDub] = energy(kept.final, 0.6, 3.0, [CLIP_HZ, DUB_HZ]);
    expect(kClip!).toBeGreaterThan(mClip! * 20); // audible again
    expect(kDub!).toBeGreaterThan(kClip! * 5);   // but far below the voice
  }, 240_000);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMotionQc, parseMotion, type MotionExec } from '../src/media/motion-qc.js';

const verdictJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  score: 38, status: 'fail', suggest: { trim: { out: 3.4 } }, features: { zoom_total: 1 },
  reasons: [
    { code: 'dissolve', severity: 'fail', penalty: 45, at_s: 1.7, value: 0.2, message: 'Gambar berganti/melebur sendiri di detik 1.7' },
    { code: 'border', severity: 'warn', penalty: 18, at_s: 2.5, value: 70, message: 'Tepi bawah makin terang' },
    { code: 'fade_dark', severity: 'info', penalty: 6, at_s: 6, value: 0.1, message: 'Klip menggelap' }
  ], ...over
});

describe('parseMotion: the checker JSON becomes the stored verdict', () => {
  it('keeps status, score, the warn/fail reasons as plain sentences, and the free suggestion', () => {
    expect(parseMotion(verdictJson())).toEqual({
      status: 'fail', score: 38,
      reasons: ['Gambar berganti/melebur sendiri di detik 1.7', 'Tepi bawah makin terang'],
      suggest: { trimOut: 3.4 }
    });
  });
  it('maps trim.in and zoom; drops a nonsense zoom or trim', () => {
    expect(parseMotion(verdictJson({ suggest: { trim: { in: 2.17 }, zoom: 1.12 } }))!.suggest).toEqual({ trimIn: 2.17, zoom: 1.12 });
    expect(parseMotion(verdictJson({ suggest: { zoom: 3, trim: { out: -1 } } }))!.suggest).toBeUndefined();
    expect(parseMotion(verdictJson({ suggest: {} }))!.suggest).toBeUndefined();
  });
  it('an ok clip has no reasons', () => {
    expect(parseMotion(verdictJson({ status: 'ok', score: 100, reasons: [], suggest: {} }))).toEqual({ status: 'ok', score: 100, reasons: [] });
  });
  it('takes the last line (python warnings before it do not matter)', () => {
    expect(parseMotion(`RuntimeWarning: something\n${verdictJson()}\n`)!.status).toBe('fail');
  });
  it('anything that is not a whole verdict is no verdict', () => {
    for (const bad of ['', 'not json', '{"error":"ffmpeg: boom"}', '{"status":"great","score":1,"reasons":[]}', '{"status":"ok","reasons":[]}', '{"status":"ok","score":"x","reasons":[]}', '{"status":"ok","score":90}', 'null', '[]']) {
      expect(parseMotion(bad), bad).toBeUndefined();
    }
  });
});

describe('createMotionQc (fake runner)', () => {
  const input = { file: '/data/stories/story_x/01-a b.mp4', move: 'push-in', look: 'painterly' };

  it('runs `nice -n 10 python3 clipqc.py` with the move, the look, the clip last — and a file name with spaces stays one argument', async () => {
    const seen: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
    const exec: MotionExec = async (cmd, args, opts) => { seen.push({ cmd, args, ...opts }); return verdictJson(); };
    const qc = createMotionQc({ exec, python: 'python3', script: '/app/bridge/py/clipqc.py' });
    expect((await qc.check(input))!.status).toBe('fail');
    expect(seen[0]).toEqual({ cmd: 'nice', timeoutMs: 20_000, args: ['-n', '10', 'python3', '/app/bridge/py/clipqc.py', '--move', 'push-in', '--look', 'painterly', '--', '/data/stories/story_x/01-a b.mp4'] });
  });

  it('adds --keyframe and --zoom only when there are some', async () => {
    const seen: string[][] = [];
    const exec: MotionExec = async (_c, args) => { seen.push(args); return verdictJson(); };
    const qc = createMotionQc({ exec });
    await qc.check({ ...input, keyframe: '/k/frame.png', zoom: 1.2 });
    await qc.check({ ...input, zoom: 1 });
    expect(seen[0]).toEqual(expect.arrayContaining(['--keyframe', '/k/frame.png', '--zoom', '1.2']));
    expect(seen[1]).not.toContain('--zoom');
    expect(seen[1]).not.toContain('--keyframe');
  });

  it('a runner that fails, times out or prints garbage gives no verdict and never throws', async () => {
    for (const exec of [
      (async () => { throw new Error('spawn nice ENOENT'); }) as MotionExec,
      (async () => { throw Object.assign(new Error('killed'), { killed: true }); }) as MotionExec,
      (async () => '{"error":"ffmpeg: Invalid data"}') as MotionExec,
      (async () => 'Traceback (most recent call last)') as MotionExec
    ]) {
      await expect(createMotionQc({ exec }).check(input)).resolves.toBeUndefined();
    }
  });

  it('one at a time: a second request waits for the first, in order, and a failure does not stall the line', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const exec: MotionExec = async (_c, args) => {
      active += 1; peak = Math.max(peak, active);
      order.push(args.at(-1)!);
      await new Promise(r => setTimeout(r, 20));
      active -= 1;
      if (args.at(-1) === 'b.mp4') throw new Error('boom');
      return verdictJson();
    };
    const qc = createMotionQc({ exec });
    const out = await Promise.all(['a.mp4', 'b.mp4', 'c.mp4'].map(file => qc.check({ ...input, file })));
    expect(peak).toBe(1);
    expect(order).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(out.map(v => v?.status)).toEqual(['fail', undefined, 'fail']);
  });
});

describe('createMotionQc (real process)', () => {
  it('kills a checker that hangs past the limit and answers nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-motion-'));
    const script = join(dir, 'hang.mjs');
    writeFileSync(script, 'setTimeout(() => console.log("{}"), 30000);\n');
    const qc = createMotionQc({ python: process.execPath, script, timeoutMs: 400 });
    const t = Date.now();
    await expect(qc.check({ file: join(dir, 'x.mp4'), move: 'static', look: 'painterly' })).resolves.toBeUndefined();
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('end to end with the real bridge/py/clipqc.py on a real clip: a still picture is a verdict (warn: under-animated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-motion-'));
    const clip = join(dir, '01-still.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x445566:s=180x320:r=24:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const v = await createMotionQc({ python: process.env.STORY_PYTHON ?? 'python3' }).check({ file: clip, move: 'static', look: 'painterly' });
    expect(v).toBeDefined();
    expect(v!.status).not.toBe('ok');
    expect(v!.reasons.join(' ')).toMatch(/gambar diam|membeku/);
  });
});

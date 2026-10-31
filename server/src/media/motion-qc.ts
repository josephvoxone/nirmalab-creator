import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MotionInput, MotionVerdict } from '../stories/service.js';

/** bridge/py/clipqc.py — copied into the image next to assemble.py. */
export const CLIPQC = process.env.STORY_CLIPQC
  ?? fileURLToPath(new URL('../../../bridge/py/clipqc.py', import.meta.url));

export const MOTION_TIMEOUT_MS = 20_000;

/** How a command is run (injected by tests): resolves with stdout, rejects on exit ≠ 0 / timeout. */
export type MotionExec = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<string>;

const realExec: MotionExec = (cmd, args, { timeoutMs }) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

type RawReason = { severity?: unknown; message?: unknown };
type RawVerdict = { status?: unknown; score?: unknown; reasons?: unknown; suggest?: { trim?: { in?: unknown; out?: unknown }; zoom?: unknown }; error?: unknown };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);

/** The checker's JSON → the stored verdict; anything that is not a complete verdict is no verdict. */
export function parseMotion(stdout: string): MotionVerdict | undefined {
  let raw: RawVerdict;
  try {
    raw = JSON.parse(stdout.trim().split('\n').pop() ?? '') as RawVerdict;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || raw.error !== undefined) return undefined;
  const status = raw.status;
  const score = num(raw.score);
  if ((status !== 'ok' && status !== 'warn' && status !== 'fail') || score === undefined || !Array.isArray(raw.reasons)) return undefined;
  // `info` reasons (e.g. a clip that fades to dark on purpose) shape the score but are not shown as problems.
  const reasons = (raw.reasons as RawReason[])
    .filter(r => (r.severity === 'fail' || r.severity === 'warn') && typeof r.message === 'string' && r.message)
    .map(r => (r.message as string).slice(0, 300))
    .slice(0, 6);
  const trimOut = num(raw.suggest?.trim?.out);
  const trimIn = num(raw.suggest?.trim?.in);
  const zoom = num(raw.suggest?.zoom);
  const suggest = {
    ...(trimOut !== undefined && trimOut > 0 ? { trimOut } : {}),
    ...(trimIn !== undefined && trimIn > 0 ? { trimIn } : {}),
    ...(zoom !== undefined && zoom > 1 && zoom <= 1.4 ? { zoom } : {})
  };
  return { status, score: Math.max(0, Math.min(100, score)), reasons, ...(Object.keys(suggest).length ? { suggest } : {}) };
}

export type MotionQcOptions = { python?: string; script?: string; exec?: MotionExec; timeoutMs?: number };

/**
 * The motion checker the story service uses: `nice python3 clipqc.py <clip> …`, one at a time (it is CPU work next to
 * the assembler), 20 s limit and a kill. Never throws: any failure (python or numpy missing, bad clip, timeout,
 * garbage output) resolves `undefined` = no verdict, and the clip is used as before.
 */
export function createMotionQc(options: MotionQcOptions = {}): { check: (input: MotionInput) => Promise<MotionVerdict | undefined> } {
  const exec = options.exec ?? realExec;
  const python = options.python ?? process.env.STORY_PYTHON ?? 'python3';
  const script = options.script ?? CLIPQC;
  const timeoutMs = options.timeoutMs ?? MOTION_TIMEOUT_MS;
  let line: Promise<unknown> = Promise.resolve();

  const one = async (input: MotionInput): Promise<MotionVerdict | undefined> => {
    // `--` keeps a file name that starts with a dash from being read as an option.
    const args = ['-n', '10', python, script, '--move', input.move, '--look', input.look,
      ...(input.keyframe ? ['--keyframe', input.keyframe] : []),
      ...(input.zoom && input.zoom > 1 ? ['--zoom', String(input.zoom)] : []), '--', input.file];
    try {
      return parseMotion(await exec('nice', args, { timeoutMs }));
    } catch {
      return undefined;
    }
  };
  return {
    // One at a time, whoever asks (collect of several stories, a backfill): a queue, not a pile of processes.
    check: input => {
      const run = line.then(() => one(input));
      line = run;
      return run;
    }
  };
}

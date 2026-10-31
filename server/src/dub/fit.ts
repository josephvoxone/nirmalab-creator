/**
 * "Does this line fit its shot?" — free, deterministic, no ElevenLabs call.
 *
 * Dub length from the text: `seconds ≈ 0.0599·characters + 0.390·commas + 0.628·sentence ends (+0.6 per quoted segment)`,
 * fitted by least squares on the 21 real Lentera dubs (eleven_multilingual_v2, speed 1): RMSE 0.41 s in-sample,
 * 0.47 s / MAPE 8% leave-one-out. One voice and one model so far: the numbers are a starting point, not a law.
 *
 * The window is what `bridge/py/assemble.py` gives a dub: clip − DUB_LEAD − crossfade (0.2 for the last shot). A dub longer
 * than the window is sped up (≤ MAX_DUB_TEMPO) and then cut; the last shot holds its frame instead. The constants below are
 * copies of assemble.py and `dub-fit.test.ts` reads that file to keep them equal.
 */
export const DUB_LEAD = 0.3;
export const MAX_DUB_TEMPO = 1.25;
export const CROSSFADE = 0.3;
export const LAST_CROSSFADE = 0.2;
const MIN_CLIP = 1.0;
/** A Flow (Veo) clip is 6 s; the exact probed length is used when the story knows it. */
export const DEFAULT_CLIP_SEC = 6.037;
/** Past this ratio the dub is audibly sped up (the model catches 8 of the 8 Lentera lines that really were > 1.1). */
export const WARN_RATIO = 1.05;
/** Past this ratio (not the last shot) the render is held back until the writer accepts it: ~28% of lines here get cut. */
export const BLOCK_RATIO = 1.2;
const COEF = { perChar: 0.0599, perComma: 0.39, perEnd: 0.628, perQuote: 0.6 };

export type FitLevel = 'ok' | 'warn' | 'hold' | 'block';
export type FitView = {
  ratio: number; level: FitLevel;
  /** Characters to cut to fit the window (when the ratio is over WARN_RATIO). */
  suggestChars?: number;
  predictedSec: number; windowSec: number;
  /** `measured` = the dub already exists and its real length was used. */
  basis: 'predicted' | 'measured';
  /** Last shot only: seconds of its last frame the assembler will hold so the line is heard to the end. */
  holdSec?: number;
};

export function textFeatures(text: string): { chars: number; commas: number; ends: number; quotes: number } {
  return {
    chars: text.length,
    commas: (text.match(/[,，]/g) ?? []).length,
    ends: (text.match(/[.!?…]+/g) ?? []).length,
    quotes: (text.match(/"[^"]*"|“[^”]*”/g) ?? []).length
  };
}

export function predictDubSeconds(text: string, speed = 1): number {
  const f = textFeatures(text);
  const base = COEF.perChar * f.chars + COEF.perComma * f.commas + COEF.perEnd * f.ends + COEF.perQuote * f.quotes;
  return base / (speed > 0 ? speed : 1);
}

/** Seconds a clip plays: its trim In..Out inside the file, never shorter than MIN_CLIP (assemble.py `clip_window`). */
export function clipSeconds(trim: { in?: number; out?: number } | undefined, full: number): number {
  let end = Math.min(Number(trim?.out ?? full) || full, full);
  let start = Math.max(0, Number(trim?.in ?? 0) || 0);
  if (end - start < MIN_CLIP) { start = Math.max(0, end - MIN_CLIP); if (end - start < MIN_CLIP) end = start + MIN_CLIP; }
  return Math.round((Math.min(end, full) - start) * 1000) / 1000;
}

export function windowSeconds(o: { clipSec: number; isLast: boolean; crossfade?: number }): number {
  return o.clipSec - DUB_LEAD - (o.isLast ? LAST_CROSSFADE : (o.crossfade ?? CROSSFADE));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function fitFor(o: { text: string; windowSec: number; isLast: boolean; speed?: number; measuredSec?: number }): FitView {
  const speed = o.speed && o.speed > 0 ? o.speed : 1;
  const measured = typeof o.measuredSec === 'number' && o.measuredSec > 0;
  const sec = measured ? o.measuredSec! : predictDubSeconds(o.text, speed);
  const window = o.windowSec;
  const ratio = window > 0 ? sec / window : Infinity;
  let level: FitLevel = 'ok';
  let holdSec: number | undefined;
  if (ratio > WARN_RATIO) {
    level = 'warn';
    if (o.isLast) {
      if (sec / MAX_DUB_TEMPO > window) { level = 'hold'; holdSec = round3(sec / MAX_DUB_TEMPO - window + 0.35); } // assemble.py tail_hold
    } else if (ratio > BLOCK_RATIO) level = 'block';
  }
  const suggestChars = ratio > WARN_RATIO ? Math.max(1, Math.ceil(((sec - window) * speed) / COEF.perChar)) : undefined;
  return {
    ratio: Number.isFinite(ratio) ? round3(ratio) : 99, level, predictedSec: round3(sec), windowSec: round3(window), basis: measured ? 'measured' : 'predicted',
    ...(suggestChars !== undefined ? { suggestChars } : {}), ...(holdSec !== undefined ? { holdSec } : {})
  };
}

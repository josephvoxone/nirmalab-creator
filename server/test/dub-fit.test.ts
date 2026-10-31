import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_RATIO, CROSSFADE, DUB_LEAD, LAST_CROSSFADE, MAX_DUB_TEMPO, WARN_RATIO, clipSeconds, fitFor, predictDubSeconds, textFeatures, windowSeconds, type FitLevel } from '../src/dub/fit.js';

type Row = { id: string; text: string; chars: number; seconds: number; clipSeconds: number; trim?: { in?: number; out?: number }; last: boolean };
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lentera-dub.json'), 'utf8')) as { shots: Row[]; speed: number };
const rows = fixture.shots;
const windowOf = (r: Row) => windowSeconds({ clipSec: clipSeconds(r.trim, r.clipSeconds), isLast: r.last });
const rank: Record<FitLevel, number> = { ok: 0, warn: 1, hold: 2, block: 2 };

/** Least squares on [chars, commas, ends] without intercept, the way the model was derived (3x3 normal equations). */
function ols(sample: Row[]): [number, number, number] {
  const x = sample.map(r => { const f = textFeatures(r.text); return [f.chars, f.commas, f.ends]; });
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const b = [0, 0, 0];
  sample.forEach((r, k) => { for (let i = 0; i < 3; i++) { b[i]! += x[k]![i]! * r.seconds; for (let j = 0; j < 3; j++) a[i]![j]! += x[k]![i]! * x[k]![j]!; } });
  for (let i = 0; i < 3; i++) { // gauss
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[p]![i]!)) p = r;
    [a[i], a[p]] = [a[p]!, a[i]!]; [b[i], b[p]] = [b[p]!, b[i]!];
    for (let r = i + 1; r < 3; r++) { const m = a[r]![i]! / a[i]![i]!; for (let c = i; c < 3; c++) a[r]![c]! -= m * a[i]![c]!; b[r]! -= m * b[i]!; }
  }
  const out = [0, 0, 0] as [number, number, number];
  for (let i = 2; i >= 0; i--) { let v = b[i]!; for (let j = i + 1; j < 3; j++) v -= a[i]![j]! * out[j]!; out[i] = v / a[i]![i]!; }
  return out;
}
const stats = (pairs: Array<[number, number]>) => ({
  rmse: Math.sqrt(pairs.reduce((n, [p, t]) => n + (p - t) ** 2, 0) / pairs.length),
  mape: pairs.reduce((n, [p, t]) => n + Math.abs(p - t) / t, 0) / pairs.length
});

describe('S7: dub length from the text (real Lentera dubs, n=21)', () => {
  it('counts what the model uses: characters, commas, sentence ends (a run of . ! ? is one end), quoted segments', () => {
    expect(textFeatures('Tuhan menunjukkan dua jalan.')).toEqual({ chars: 28, commas: 0, ends: 1, quotes: 0 });
    expect(textFeatures('Satu penuh bunga, satunya gelap. Bayu memilih yang mudah?!')).toMatchObject({ commas: 1, ends: 2 });
    expect(textFeatures('Tunggu... lalu pergi.')).toMatchObject({ ends: 2 });
    expect(textFeatures('Kata Tuhan, "Terima kasih. Kau setia. Ini upahmu: sekeping perak."')).toMatchObject({ commas: 1, ends: 3, quotes: 1 });
    expect(textFeatures('Dia berkata “pergi” dan “pulang”.').quotes).toBe(2);
  });

  it('the shipped coefficients predict the 21 real dubs within 0.50 s RMSE and 9% MAPE', () => {
    const s = stats(rows.map(r => [predictDubSeconds(r.text, fixture.speed), r.seconds]));
    expect(s.rmse).toBeLessThanOrEqual(0.5);
    expect(s.mape).toBeLessThanOrEqual(0.09);
  });

  it('leave-one-out refit of the same model stays at 0.55 s / 9%, and the shipped coefficients are that fit (no tuning on the test)', () => {
    const pairs = rows.map((r, i): [number, number] => { const [c, k, e] = ols(rows.filter((_, j) => j !== i)); const f = textFeatures(r.text); return [c * f.chars + k * f.commas + e * f.ends, r.seconds]; });
    const s = stats(pairs);
    expect(s.rmse).toBeLessThanOrEqual(0.55);
    expect(s.mape).toBeLessThanOrEqual(0.09);
    const [perChar, perComma, perEnd] = ols(rows);
    expect(perChar).toBeCloseTo(0.0599, 2); expect(perComma).toBeCloseTo(0.39, 1); expect(perEnd).toBeCloseTo(0.628, 1);
    expect(predictDubSeconds('a'.repeat(100))).toBeCloseTo(100 * 0.0599, 1);
    expect(predictDubSeconds('Halo, dunia.')).toBeCloseTo(12 * 0.0599 + 0.39 + 0.628, 2);
  });

  it('a quoted segment adds a 0.6 s margin; a slower voice divides, a faster one multiplies', () => {
    const plain = predictDubSeconds('Kata Tuhan, Terima kasih. Kau setia. Ini upahmu: sekeping perak.');
    const quoted = predictDubSeconds('Kata Tuhan, "Terima kasih. Kau setia. Ini upahmu: sekeping perak."');
    expect(quoted - plain).toBeCloseTo(0.6 + 2 * 0.0599, 2);
    expect(predictDubSeconds('Halo dunia yang indah.', 0.8)).toBeCloseTo(predictDubSeconds('Halo dunia yang indah.', 1) / 0.8, 5);
    expect(predictDubSeconds('')).toBe(0);
  });
});

describe('S7: the window a dub has to fit, as assemble.py computes it', () => {
  const py = readFileSync(join(import.meta.dirname, '..', '..', 'bridge', 'py', 'assemble.py'), 'utf8');
  const num = (re: RegExp) => { const m = py.match(re); if (!m) throw new Error(`not found in assemble.py: ${re}`); return Number(m[1]); };

  it('DUB_LEAD, MAX_DUB_TEMPO, the crossfade default and the last-shot crossfade are the numbers assemble.py uses', () => {
    expect(DUB_LEAD).toBe(num(/^DUB_LEAD\s*=\s*([\d.]+)/m));
    expect(MAX_DUB_TEMPO).toBe(num(/^MAX_DUB_TEMPO\s*=\s*([\d.]+)/m));
    expect(CROSSFADE).toBe(num(/story\.get\('crossfade',\s*([\d.]+)\)/));
    expect(LAST_CROSSFADE).toBe(num(/window = durations\[i\] - DUB_LEAD - \(xf if i < len\(durations\) - 1 else ([\d.]+)\)/));
  });

  it('window = clip − 0.3 lead − 0.3 crossfade (0.2 for the last shot); a trim shortens the clip like clip_window', () => {
    expect(windowOf(rows[1]!)).toBeCloseTo(5.437, 2); // audit: 5.44
    expect(windowOf(rows[20]!)).toBeCloseTo(5.537, 2); // audit: 5.54 (last)
    expect(windowOf(rows[0]!)).toBeCloseTo(2.6, 2); // trim.out 3.2
    expect(clipSeconds({ in: 1, out: 4 }, 6)).toBe(3);
    expect(clipSeconds({ out: 99 }, 6)).toBe(6); // never past the clip
    expect(clipSeconds({ in: 5.8, out: 6 }, 6)).toBeCloseTo(1, 5); // MIN_CLIP 1.0 like assemble.py
    expect(windowSeconds({ clipSec: 6, isLast: false, crossfade: 0.5 })).toBeCloseTo(5.2, 5);
  });
});

describe('S7: the level of each Lentera line (warn above 1.05, hold above 1.20, last shot holds its frame)', () => {
  const fits = rows.map(r => ({ r, f: fitFor({ text: r.text, windowSec: windowOf(r), isLast: r.last, speed: fixture.speed }) }));

  it('every line whose REAL dub is more than 10% over its window is flagged (8 of 8), with at most 2 false alarms', () => {
    const real = fits.filter(({ r }) => r.seconds / windowOf(r) > 1.1);
    expect(real).toHaveLength(8);
    expect(real.every(({ f }) => rank[f.level] >= 1)).toBe(true);
    const falseAlarms = fits.filter(({ r, f }) => r.seconds / windowOf(r) <= 1.1 && rank[f.level] >= 1);
    expect(falseAlarms.length).toBeLessThanOrEqual(3);
  });

  it('the closing line (shot 21) is "hold" — never "block": the assembler holds the last frame instead of cutting it', () => {
    const last = fits[20]!.f;
    expect(last.level).toBe('hold');
    expect(last.holdSec).toBeGreaterThan(0.5);
    expect(fits.filter(({ f }) => f.level === 'hold')).toHaveLength(1);
  });

  it('the ratio and the level boundaries: ≤1.05 ok, >1.05 warn, >1.20 block (not last); last: hold only past the max tempo', () => {
    const at = (ratio: number, isLast = false) => fitFor({ text: 'a'.repeat(Math.round(ratio * 5 / 0.0599)), windowSec: 5, isLast });
    expect(WARN_RATIO).toBe(1.05); expect(BLOCK_RATIO).toBe(1.2);
    expect(at(0.8).level).toBe('ok');
    expect(at(1.04).level).toBe('ok');
    expect(at(1.08).level).toBe('warn');
    expect(at(1.18).level).toBe('warn');
    expect(at(1.3).level).toBe('block');
    expect(at(1.22, true).level).toBe('warn'); // the last shot is never blocked: up to ×1.25 it is only sped up
    expect(at(1.3, true).level).toBe('hold'); // past ×1.25 the last frame is held instead of cutting the line
    expect(at(1.08).ratio).toBeCloseTo(1.08, 1);
  });

  it('measured seconds of a finished dub beat the prediction', () => {
    const f = fitFor({ text: 'a'.repeat(50), windowSec: 5, isLast: false, measuredSec: 6.5 });
    expect(f).toMatchObject({ basis: 'measured', level: 'block' });
    expect(f.ratio).toBeCloseTo(1.3, 3);
  });

  it('suggestChars says how many characters to cut to fit the window (±3), nothing when it already fits', () => {
    const text = 'a'.repeat(100); // 5.99 s in a 5.44 s window
    const f = fitFor({ text, windowSec: 5.44, isLast: false });
    expect(f.suggestChars).toBeGreaterThanOrEqual(8);
    const cut = predictDubSeconds('a'.repeat(100 - f.suggestChars!));
    expect(cut).toBeLessThanOrEqual(5.44 + 0.0599 * 3);
    expect(cut).toBeGreaterThanOrEqual(5.44 - 0.0599 * 3);
    expect(fitFor({ text: 'a'.repeat(50), windowSec: 5.44, isLast: false }).suggestChars).toBeUndefined();
    const slow = fitFor({ text, windowSec: 5.44, isLast: false, speed: 0.8 }); // a slower voice needs a bigger cut
    expect(slow.suggestChars!).toBeGreaterThan(f.suggestChars!);
  });
});

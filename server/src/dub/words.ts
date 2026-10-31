/**
 * Word timings for the karaoke subtitles: `[word, startSeconds, endSeconds]`, relative to the start of the dub audio.
 *
 * Real timings come from ElevenLabs' per-character alignment (`/with-timestamps`). Audio that was rendered before the
 * timings were kept gets a proportional estimate instead, so the sweep still runs (roughly right, never wrong-footed
 * by a missing file).
 */
export type Word = [string, number, number];
export type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function wordsFromAlignment(alignment: unknown): Word[] | undefined {
  const a = alignment as Partial<Alignment> | null | undefined;
  if (!a || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) return undefined;
  const { characters: ch, character_start_times_seconds: st, character_end_times_seconds: en } = a;
  if (ch.length === 0 || ch.length !== st.length || ch.length !== en.length) return undefined;
  if (!st.every(Number.isFinite) || !en.every(Number.isFinite)) return undefined;
  const out: Word[] = [];
  let text = ''; let start = 0; let end = 0;
  const flush = () => {
    if (!text) return;
    const prevEnd = out.length ? out[out.length - 1]![2] : 0;
    const s = Math.max(start, prevEnd);
    out.push([text, round3(s), round3(Math.max(end, s))]);
    text = '';
  };
  for (let i = 0; i < ch.length; i++) {
    const c = String(ch[i]);
    if (/^\s*$/.test(c)) { flush(); continue; }
    if (!text) start = st[i]!;
    text += c; end = en[i]!;
  }
  flush();
  return out.length ? out : undefined;
}

/** Words laid over `seconds` of audio in proportion to their length, with a longer rest after a sentence end or a comma. */
export function estimateWords(text: string, seconds: number): Word[] | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !(seconds > 0)) return undefined;
  const pause = (w: string) => (/[.!?…]["”’)]*$/.test(w) ? 4 : /[,;:]["”’)]*$/.test(w) ? 2 : 0.5);
  const units = words.reduce((n, w, i) => n + w.length + (i < words.length - 1 ? pause(w) : 0), 0);
  const lead = Math.min(0.05, seconds * 0.02); const tail = Math.min(0.08, seconds * 0.03);
  const unit = Math.max(0, seconds - lead - tail) / units;
  const out: Word[] = [];
  let t = lead;
  words.forEach((w, i) => {
    const d = w.length * unit;
    out.push([w, round3(t), round3(t + d)]);
    t += d + (i < words.length - 1 ? pause(w) * unit : 0);
  });
  return out;
}

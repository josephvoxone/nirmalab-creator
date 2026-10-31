/**
 * Dubbing of a story, per shot / per scene / all: the text of each shot is spoken by ElevenLabs and stored as
 * `<story>/dub/<shot>-<hash>.mp3`; `<story>/dub.json` holds the settings and one entry per shot.
 *
 * Money rules (ElevenLabs bills characters):
 *  - `render` starts only when the caller sends `confirmCredits` equal to the server's own estimate;
 *  - a shot whose text, voice, model and voice settings did not change (same hash) is never rendered again;
 *  - work goes through a `FairQueue`, so many users cannot open unlimited provider calls at once.
 * The assembler mixes only FRESH dubs (hash matches what the shot says now).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DUB_MODEL, DUB_MODELS, DubError, MAX_TEXT_CHARS, estimateCredits, isDubModel, type DubModel, type SynthesizeInput, type VoiceSettings } from './elevenlabs.js';
import type { FairQueue } from '../lib/fair-queue.js';
import { estimateWords, type Word } from './words.js';
import { SHOT_ID, narrationOf, type Shot, type Storyboard } from '../stories/storyboard.js';

export type DubSettings = { voiceId?: string; modelId: string; languageCode: string; voice: Required<VoiceSettings>; keepAmbient: boolean };
export type SettingsPatch = { voiceId?: string | null; modelId?: string; voice?: VoiceSettings; keepAmbient?: boolean };
export type DubScope = { kind: 'all' } | { kind: 'scene'; sceneId: string } | { kind: 'shots'; shotIds: string[] };
export type ShotStatus = 'none' | 'queued' | 'running' | 'done' | 'stale' | 'failed';

type ShotDub = { text?: string; voiceId?: string; hash?: string; file?: string; seconds?: number; chars?: number; words?: Word[]; status?: 'queued' | 'running' | 'failed'; error?: string; atMs?: number };
type Doc = { version: 1; settings: DubSettings; shots: Record<string, ShotDub> };

export type ShotView = {
  shotId: string; sceneId?: string; text: string; textSource: 'narration' | 'override'; voiceId?: string; chars: number;
  status: ShotStatus; skipped: boolean; tooLong: boolean; error?: string; seconds?: number; audio?: string;
};
export type DubState = {
  configured: boolean; settings: DubSettings; models: DubModel[];
  shots: ShotView[];
  totals: { dubbable: number; done: number; stale: number; failed: number; active: number; chars: number };
};
export type DubPlan = { shotIds: string[]; chars: number; credits: number; modelId: string };
/** `words`: when each word is spoken (seconds into the file), for the karaoke subtitles. */
export type AssemblyDub = { keepAmbient: boolean; shots: Record<string, { file: string; seconds: number; words?: Word[] }> };

export type DubDeps = {
  dir: (storyId: string) => string;
  board: (storyId: string) => Promise<Storyboard>;
  markStale: (storyId: string) => Promise<void>;
  client: { configured(): boolean; synthesize(input: SynthesizeInput): Promise<{ audio: Buffer; keyId: string; words?: Word[] }> };
  queue: FairQueue;
  probe: (file: string) => Promise<number>;
};

export const DEFAULT_VOICE: Required<VoiceSettings> = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true };
const VOICE_ID = /^[A-Za-z0-9_-]{2,64}$/;
const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

function defaults(): DubSettings {
  return { modelId: DEFAULT_DUB_MODEL, languageCode: 'id', voice: { ...DEFAULT_VOICE }, keepAmbient: false };
}

export class DubService {
  private readonly mutexes = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly deps: DubDeps) {}

  // ------------------------------------------------------------------ storage

  private docPath(id: string): string { return join(this.deps.dir(id), 'dub.json'); }

  private async read(id: string): Promise<Doc> {
    try {
      const raw = JSON.parse(await readFile(this.docPath(id), 'utf8')) as Partial<Doc>;
      const base = defaults();
      return { version: 1, settings: { ...base, ...(raw.settings ?? {}), voice: { ...base.voice, ...(raw.settings?.voice ?? {}) } }, shots: raw.shots && typeof raw.shots === 'object' ? raw.shots : {} };
    } catch {
      return { version: 1, settings: defaults(), shots: {} };
    }
  }

  /** Read-modify-write of dub.json, one at a time per story. */
  private mutate<T>(id: string, fn: (doc: Doc) => T | Promise<T>): Promise<T> {
    const prev = this.mutexes.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const doc = await this.read(id);
      const out = await fn(doc);
      await mkdir(this.deps.dir(id), { recursive: true });
      const tmp = `${this.docPath(id)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
      await rename(tmp, this.docPath(id));
      return out;
    });
    this.mutexes.set(id, next);
    void next.finally(() => { if (this.mutexes.get(id) === next) this.mutexes.delete(id); }).catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------ derived values

  private effective(doc: Doc, shot: Shot) {
    const own = doc.shots[shot.id] ?? {};
    const override = typeof own.text === 'string' && own.text.trim() ? own.text.trim() : undefined;
    const text = override ?? (shot.silent ? '' : narrationOf(shot));
    const voiceId = own.voiceId || doc.settings.voiceId;
    const hash = createHash('sha256').update(JSON.stringify({ t: text, v: voiceId ?? '', m: doc.settings.modelId, l: doc.settings.languageCode, s: doc.settings.voice })).digest('hex').slice(0, 16);
    return { text, textSource: override ? 'override' as const : 'narration' as const, voiceId, hash, entry: own };
  }

  private statusOf(doc: Doc, shot: Shot): ShotStatus {
    const e = this.effective(doc, shot);
    const own = e.entry;
    if (own.status === 'queued' || own.status === 'running') return own.status;
    if (own.file && own.hash === e.hash) return 'done';
    if (own.file) return 'stale';
    return own.status === 'failed' ? 'failed' : 'none';
  }

  async state(id: string): Promise<DubState> {
    const [doc, board] = await Promise.all([this.read(id), this.deps.board(id)]);
    const sceneOf = new Map<string, string>();
    for (const sc of board.scenes ?? []) for (const sid of sc.shots) sceneOf.set(sid, sc.id);
    const shots: ShotView[] = board.shots.map(shot => {
      const e = this.effective(doc, shot);
      const status = this.statusOf(doc, shot);
      return {
        shotId: shot.id, ...(sceneOf.has(shot.id) ? { sceneId: sceneOf.get(shot.id)! } : {}),
        text: e.text, textSource: e.textSource, ...(e.voiceId ? { voiceId: e.voiceId } : {}), chars: e.text.length,
        status, skipped: !e.text, tooLong: e.text.length > MAX_TEXT_CHARS,
        ...(e.entry.status === 'failed' && e.entry.error ? { error: e.entry.error } : {}),
        ...(e.entry.seconds !== undefined && e.entry.file ? { seconds: e.entry.seconds } : {}),
        ...(e.entry.file ? { audio: `${shot.id}-${(e.entry.hash ?? '').slice(0, 8)}` } : {})
      };
    });
    const dubbable = shots.filter(s => !s.skipped);
    return {
      configured: this.deps.client.configured(), settings: doc.settings, models: DUB_MODELS, shots,
      totals: {
        dubbable: dubbable.length, done: dubbable.filter(s => s.status === 'done').length, stale: dubbable.filter(s => s.status === 'stale').length,
        failed: dubbable.filter(s => s.status === 'failed').length, active: dubbable.filter(s => s.status === 'queued' || s.status === 'running').length,
        chars: dubbable.reduce((n, s) => n + s.chars, 0)
      }
    };
  }

  // ------------------------------------------------------------------ settings and per-shot edits

  async updateSettings(id: string, patch: SettingsPatch): Promise<DubState> {
    if (patch.modelId !== undefined && !isDubModel(patch.modelId)) throw new DubError('INVALID', `Model dubbing tidak dikenal: ${DUB_MODELS.map(m => m.id).join(', ')}`);
    if (typeof patch.voiceId === 'string' && !VOICE_ID.test(patch.voiceId)) throw new DubError('INVALID', 'ID suara tidak valid');
    await this.mutate(id, doc => {
      if (patch.voiceId === null) delete doc.settings.voiceId;
      else if (typeof patch.voiceId === 'string') doc.settings.voiceId = patch.voiceId;
      if (patch.modelId !== undefined) doc.settings.modelId = patch.modelId;
      if (patch.keepAmbient !== undefined) doc.settings.keepAmbient = patch.keepAmbient === true;
      if (patch.voice) {
        const v = doc.settings.voice;
        doc.settings.voice = {
          stability: clamp(patch.voice.stability, 0, 1, v.stability), similarityBoost: clamp(patch.voice.similarityBoost, 0, 1, v.similarityBoost),
          style: clamp(patch.voice.style, 0, 1, v.style), speed: clamp(patch.voice.speed, 0.7, 1.2, v.speed),
          speakerBoost: typeof patch.voice.speakerBoost === 'boolean' ? patch.voice.speakerBoost : v.speakerBoost
        };
      }
    });
    return this.state(id);
  }

  /** Text / voice of one shot; `null` removes the override. */
  async setShot(id: string, shotId: string, patch: { text?: string | null; voiceId?: string | null }): Promise<DubState> {
    await this.requireShot(id, shotId);
    if (typeof patch.voiceId === 'string' && !VOICE_ID.test(patch.voiceId)) throw new DubError('INVALID', 'ID suara tidak valid');
    if (typeof patch.text === 'string' && patch.text.length > 5000) throw new DubError('INVALID', 'Teks dubbing terlalu panjang');
    await this.mutate(id, doc => {
      const e = (doc.shots[shotId] ??= {});
      if (patch.text === null) delete e.text; else if (typeof patch.text === 'string') e.text = patch.text;
      if (patch.voiceId === null) delete e.voiceId; else if (typeof patch.voiceId === 'string') e.voiceId = patch.voiceId;
    });
    return this.state(id);
  }

  private async requireShot(id: string, shotId: string): Promise<Shot> {
    const shot = SHOT_ID.test(shotId) ? (await this.deps.board(id)).shots.find(s => s.id === shotId) : undefined;
    if (!shot) throw new DubError('NOT_FOUND', 'Shot tidak ditemukan');
    return shot;
  }

  // ------------------------------------------------------------------ plan / render

  async plan(id: string, scope: DubScope, options: { force?: boolean } = {}): Promise<DubPlan> {
    const [doc, board] = await Promise.all([this.read(id), this.deps.board(id)]);
    let ids: string[];
    if (scope.kind === 'all') ids = board.shots.map(s => s.id);
    else if (scope.kind === 'scene') {
      const sc = (board.scenes ?? []).find(s => s.id === scope.sceneId);
      if (!sc) throw new DubError('NOT_FOUND', 'Scene tidak ditemukan');
      ids = sc.shots;
    } else {
      const known = new Set(board.shots.map(s => s.id));
      if (!scope.shotIds.length || scope.shotIds.some(s => !known.has(s))) throw new DubError('NOT_FOUND', 'Shot tidak ditemukan');
      ids = scope.shotIds;
    }
    const byId = new Map(board.shots.map(s => [s.id, s]));
    const chosen: string[] = [];
    const texts: string[] = [];
    for (const sid of ids) {
      const shot = byId.get(sid)!;
      const e = this.effective(doc, shot);
      if (!e.text) continue;
      if (e.text.length > MAX_TEXT_CHARS) throw new DubError('INVALID', `Teks ${sid} terlalu panjang (${e.text.length} > ${MAX_TEXT_CHARS} karakter).`);
      if (!e.voiceId) throw new DubError('INVALID', 'Pilih suara dulu (suara cerita atau suara shot).');
      const status = this.statusOf(doc, shot);
      if (options.force || status === 'none' || status === 'stale' || status === 'failed') { chosen.push(sid); texts.push(e.text); }
    }
    return { shotIds: chosen, chars: texts.reduce((n, t) => n + t.length, 0), credits: estimateCredits(texts, doc.settings.modelId), modelId: doc.settings.modelId };
  }

  async render(id: string, scope: DubScope, opts: { owner: string; confirmCredits?: number; force?: boolean }): Promise<DubState> {
    const plan = await this.plan(id, scope, opts.force ? { force: true } : {});
    if (!plan.shotIds.length) return this.state(id);
    if (!this.deps.client.configured()) throw new DubError('NOT_CONFIGURED', 'API key ElevenLabs belum diisi. Isi di Pengaturan › Provider › ElevenLabs.');
    if (typeof opts.confirmCredits !== 'number' || Math.abs(opts.confirmCredits - plan.credits) > 0.01) {
      throw new DubError('CONFIRM_REQUIRED', `Dubbing ${plan.shotIds.length} shot memakai ±${plan.credits} kredit ElevenLabs (${plan.chars} karakter, model ${plan.modelId}). Konfirmasi dulu.`);
    }
    await this.mutate(id, doc => { for (const sid of plan.shotIds) { const e = (doc.shots[sid] ??= {}); e.status = 'queued'; delete e.error; } });
    this.enqueue(id, plan.shotIds, opts.owner);
    return this.state(id);
  }

  private enqueue(id: string, shotIds: string[], owner: string): void {
    let ctl = this.aborts.get(id);
    if (!ctl || ctl.signal.aborted) { ctl = new AbortController(); this.aborts.set(id, ctl); }
    const set = this.pending.get(id) ?? new Set<Promise<unknown>>();
    this.pending.set(id, set);
    for (const sid of shotIds) {
      const p = this.deps.queue.run(owner, () => this.renderShot(id, sid), { signal: ctl.signal })
        .catch(async error => {
          if ((error as Error)?.name === 'AbortError') await this.mutate(id, doc => { const e = doc.shots[sid]; if (e?.status === 'queued') delete e.status; }).catch(() => undefined);
          else await this.fail(id, sid, error);
        })
        .finally(() => { set.delete(p); });
      set.add(p);
    }
  }

  private async fail(id: string, shotId: string, error: unknown): Promise<void> {
    const message = error instanceof DubError ? error.message : 'Dubbing gagal dibuat. Coba lagi.';
    await this.mutate(id, doc => { const e = (doc.shots[shotId] ??= {}); e.status = 'failed'; e.error = message.slice(0, 300); }).catch(() => undefined);
  }

  private async renderShot(id: string, shotId: string): Promise<void> {
    const [doc, board] = await Promise.all([this.read(id), this.deps.board(id)]);
    const index = board.shots.findIndex(s => s.id === shotId);
    if (index < 0) return;
    const shot = board.shots[index]!;
    const e = this.effective(doc, shot);
    const dir = join(this.deps.dir(id), 'dub');
    if (e.entry.file && e.entry.hash === e.hash) { // already fresh (e.g. a resumed duplicate): spend nothing
      await this.mutate(id, d => { if (d.shots[shotId]) delete d.shots[shotId]!.status; });
      return;
    }
    if (!e.text || !e.voiceId) { await this.mutate(id, d => { if (d.shots[shotId]) delete d.shots[shotId]!.status; }); return; }
    await this.mutate(id, d => { const x = (d.shots[shotId] ??= {}); x.status = 'running'; });
    const neighbour = (step: number): string | undefined => {
      for (let i = index + step; i >= 0 && i < board.shots.length; i += step) { const t = this.effective(doc, board.shots[i]!).text; if (t) return t; }
      return undefined;
    };
    const prev = neighbour(-1); const next = neighbour(1);
    const { audio, words } = await this.deps.client.synthesize({
      text: e.text, voiceId: e.voiceId, modelId: doc.settings.modelId, languageCode: doc.settings.languageCode, settings: doc.settings.voice,
      ...(prev ? { previousText: prev } : {}), ...(next ? { nextText: next } : {})
    });
    await mkdir(dir, { recursive: true });
    const name = `${shotId}-${e.hash.slice(0, 8)}.mp3`;
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, audio, { mode: 0o600 });
    await rename(tmp, join(dir, name));
    const seconds = Math.round((await this.deps.probe(join(dir, name))) * 1000) / 1000;
    const old = await this.mutate(id, d => {
      const x = (d.shots[shotId] ??= {});
      const previous = x.file;
      Object.assign(x, { hash: e.hash, file: `dub/${name}`, seconds, chars: e.text.length, atMs: Date.now() });
      if (words) x.words = words; else delete x.words;
      delete x.status; delete x.error;
      return previous;
    });
    if (old && old !== `dub/${name}`) await rm(join(this.deps.dir(id), old), { force: true });
    await this.deps.markStale(id);
  }

  /** Wait for every queued/running shot of one story (tests, shutdown). */
  async idle(id: string): Promise<void> {
    for (;;) {
      const set = this.pending.get(id);
      if (!set || !set.size) return;
      await Promise.allSettled([...set]);
    }
  }

  /** Stop what has not started; shots already being made finish. */
  async cancel(id: string): Promise<DubState> {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    await new Promise<void>(r => setImmediate(r));
    return this.state(id);
  }

  async remove(id: string, shotId: string): Promise<DubState> {
    await this.requireShot(id, shotId);
    const old = await this.mutate(id, doc => { const x = doc.shots[shotId]; const f = x?.file; if (x) { delete x.file; delete x.hash; delete x.seconds; delete x.chars; delete x.words; delete x.atMs; delete x.status; delete x.error; } return f; });
    if (old) { await rm(join(this.deps.dir(id), old), { force: true }); await this.deps.markStale(id); }
    return this.state(id);
  }

  /** What the assembler may mix: only dubs that are fresh for what each shot says now. */
  async dubFor(id: string): Promise<AssemblyDub> {
    const [doc, board] = await Promise.all([this.read(id), this.deps.board(id)]);
    const shots: AssemblyDub['shots'] = {};
    for (const shot of board.shots) {
      const e = this.effective(doc, shot);
      if (e.entry.file && e.entry.hash === e.hash && typeof e.entry.seconds === 'number') {
        const words = e.entry.words ?? estimateWords(e.text, e.entry.seconds);
        shots[shot.id] = { file: join(this.deps.dir(id), e.entry.file), seconds: e.entry.seconds, ...(words ? { words } : {}) };
      }
    }
    return { keepAmbient: doc.settings.keepAmbient, shots };
  }

  /** The audio file of one finished shot, or undefined. */
  async audioPath(id: string, shotId: string): Promise<string | undefined> {
    const f = (await this.read(id)).shots[shotId]?.file;
    return f && SHOT_ID.test(shotId) ? join(this.deps.dir(id), f) : undefined;
  }

  /** After a restart: shots that were queued/running (already confirmed by the user) are queued again. */
  async resume(ids: string[]): Promise<void> {
    for (const id of ids) {
      const doc = await this.read(id);
      const shotIds = Object.entries(doc.shots).filter(([, v]) => v.status === 'queued' || v.status === 'running').map(([k]) => k);
      if (!shotIds.length) continue;
      await this.mutate(id, d => { for (const sid of shotIds) if (d.shots[sid]) d.shots[sid]!.status = 'queued'; });
      this.enqueue(id, shotIds, 'resume');
    }
  }
}

/**
 * Side sheet that edits ONE shot: preview, narration (≤12 words), silent switch, framing/move,
 * prompt, cast, take status, and the shot's own actions. Saves through useProject().save(updateShot(...)).
 *
 * Bible boards (spec goal 4): a shot with an intent edits the intent fields and shows the compiled
 * prompt read-only; a prose shot keeps its prompt with "Ubah ke niat". Legacy boards: prose only.
 * Local edits survive a refused save (409 STALE reload included) until they are saved or the sheet closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Film, Loader2, Maximize2, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Choice, Segmented, textareaClass } from '../../ui/controls.js';
import { IntentFields, PromptPreview, draftOf, intentFrom, missingSlots, sameDraft, type IntentDraft } from './IntentFields.js';
import { mentionTriggers } from './mentions.js';
import { readSetup, setShotSetup, type Catalog } from '../stories/catalog.js';
import { STATUS_LABEL, isActive, type TakeState } from '../stories/storiesClient.js';
import { removeShot, sceneOf, updateShot } from './model.js';
import { ClipPreview } from './Player.js';
import { SceneCastChips } from './SceneCast.js';
import { CREDITS_PER_SHOT, TONE_TEXT, castInText, shotStatus, wordCount } from './SceneHelpers.js';
import { media, useProject } from './useProject.js';
import { playerPosterWidth, poster, sized } from '../../lib/media.js';

const MAX_WORDS = 12;
const INTENT_KEYS = ['subject', 'action', 'startState', 'endState', 'emotion', 'framing', 'move'] as const;
type Field = 'narration' | 'silent' | 'prompt' | (typeof INTENT_KEYS)[number];
const PREVIEW_H = 300;

async function fullscreen(el: HTMLElement | null) {
  if (!el) return;
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await el.requestFullscreen(); } catch { /* not allowed: ignore */ }
}

function KeyframePreview(props: { src: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="group relative inline-flex max-w-full overflow-hidden rounded-md bg-black">
      <img src={props.src} alt={props.label} decoding="async" style={{ maxHeight: PREVIEW_H }} className="block h-auto max-w-full object-contain" />
      <Button type="button" size="icon-sm" variant="glass" aria-label={`Layar penuh ${props.label}`} onClick={() => void fullscreen(ref.current)}
        className="absolute top-1.5 right-1.5 opacity-80 group-hover:opacity-100"><Maximize2 /></Button>
    </div>
  );
}

const takeLabel = (t?: Pick<TakeState, 'status'>) => (t ? (t.status === 'done' ? 'Siap' : STATUS_LABEL[t.status] ?? t.status) : '—');

function ShotEditor(props: { shotId: string; catalog?: Catalog; onClose: () => void }) {
  const p = useProject();
  const board = p.board!;
  const story = p.story!;
  const shot = board.shots.find(s => s.id === props.shotId)!;
  const scene = sceneOf(board, shot.id);
  const number = (scene ? scene.shots.indexOf(shot.id) : board.shots.indexOf(shot)) + 1;
  const st = story.shots.find(s => s.id === shot.id);
  const frame = st?.frame;

  const bible = !!board.bible;
  const upstream = useMemo(() => draftOf(shot), [shot]);
  const [narration, setNarration] = useState(shot.narration ?? '');
  const [silent, setSilent] = useState(!!shot.silent);
  const [prompt, setPrompt] = useState(shot.prompt);
  const [intent, setIntent] = useState<IntentDraft>(upstream);
  /** A bible prose shot being turned into an intent shot ("Ubah ke niat"). */
  const [converting, setConverting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * The fields the user changed since the last good save. Those are kept over a refused save or a
   * STALE reload and are the only ones a save writes; every other field follows the board, so an
   * assistant edit to another field of this shot survives.
   */
  const [touched, setTouched] = useState<ReadonlySet<Field>>(() => new Set());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!touched.has('narration')) setNarration(shot.narration ?? '');
    if (!touched.has('silent')) setSilent(!!shot.silent);
    if (!touched.has('prompt')) setPrompt(shot.prompt);
    setIntent(current => {
      const next = { ...upstream };
      for (const k of INTENT_KEYS) if (touched.has(k)) next[k] = current[k];
      return sameDraft(next, current) ? current : next;
    });
  }, [touched, shot.narration, shot.silent, shot.prompt, upstream]);
  const mark = (...fields: Field[]) => setTouched(t => (fields.every(f => t.has(f)) ? t : new Set([...t, ...fields])));
  const edit = <T,>(field: Field, set: (v: T) => void) => (v: T) => { mark(field); set(v); };
  const editIntent = (next: IntentDraft) => {
    mark(...INTENT_KEYS.filter(k => next[k] !== intent[k]));
    setIntent(next);
  };

  const intentMode = bible && (!!shot.intent || converting);
  const locked = isActive(story);
  const busy = !!p.busy;
  const words = wordCount(narration);
  const tooLong = !silent && words > MAX_WORDS;
  const missing = !silent && words === 0;
  const promptChanged = !intentMode && prompt.trim() !== shot.prompt.trim();
  const intentChanged = intentMode && (converting || !sameDraft(intent, upstream));
  const dirty = promptChanged || intentChanged || narration.trim() !== (shot.narration ?? '').trim() || silent !== !!shot.silent;
  const slotsMissing = converting && missingSlots(intent).length > 0;
  const invalid = tooLong || missing || (intentMode ? slotsMissing : !prompt.trim());
  const konsisten = story.mode === 'konsisten' && !!frame;
  const castReady = (story.cast ?? []).every(c => c.status === 'done');
  const status = shotStatus(story, shot.id);
  const setup = props.catalog ? readSetup(prompt, props.catalog) : {};
  const cast = castInText(board, story, intentMode ? [intent.subject, intent.action] : [prompt]);
  const error = st?.error ?? frame?.error;
  const retake = !error && (st?.status === 'queued' ? st.lastError : frame?.status === 'queued' ? frame.lastError : undefined);
  const triggers = useMemo(() => mentionTriggers(p.id, board, story), [p.id, board, story]);
  const previous = shot.intent;
  const draftShot = { ...shot, intent: intentFrom(intent, previous), narration: narration.trim() || undefined, silent: silent || undefined };

  const startIntent = () => {
    const camera = props.catalog ? readSetup(prompt, props.catalog) : {};
    mark(...INTENT_KEYS);
    setIntent({ subject: '', action: '', startState: '', endState: '', emotion: '', framing: camera.framing ?? '', move: camera.move ?? '' });
    setConverting(true);
  };
  const save = async () => {
    const only = touched;
    const converting_ = converting;
    // Only what the user changed, written onto the newest board (the rest may be the assistant's).
    const ok = await p.save(latest => {
      const cur = latest.shots.find(s => s.id === shot.id);
      if (!cur) return latest;
      const patch: Partial<typeof cur> = {};
      if (only.has('narration')) patch.narration = narration.trim() || undefined;
      if (only.has('silent')) patch.silent = silent || undefined;
      if (intentMode) {
        if (converting_ || INTENT_KEYS.some(k => only.has(k))) {
          const merged = draftOf(cur);
          for (const k of INTENT_KEYS) if (converting_ || only.has(k)) merged[k] = intent[k];
          patch.intent = intentFrom(merged, cur.intent);
        }
      } else if (only.has('prompt')) {
        patch.prompt = prompt.trim();
      }
      return updateShot(latest, shot.id, patch);
    });
    setFailed(!ok);
    if (ok) { setTouched(new Set()); setConverting(false); }
    return ok;
  };
  const remove = async () => {
    setConfirming(false);
    if (await p.save(removeShot(board, shot.id))) props.onClose();
  };

  const narrationBlock = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span id={`narasi-${shot.id}`}>Narasi</span>
        <span className={cn('tabular-nums', tooLong && 'font-medium text-destructive')}>{words}/{MAX_WORDS}</span>
      </div>
      <textarea aria-labelledby={`narasi-${shot.id}`} rows={2} value={narration} disabled={locked || silent} aria-invalid={tooLong || undefined}
        placeholder={silent ? 'Shot ini tanpa narasi' : 'Maksimal 12 kata, agar muat ±6 detik'} onChange={e => edit('narration', setNarration)(e.target.value)}
        className={cn(textareaClass, 'min-h-14', tooLong && 'border-destructive')} />
      {tooLong && <span className="text-[11.5px] text-destructive">Narasi maksimal {MAX_WORDS} kata agar muat ±6 detik.</span>}
      {missing && <span className="text-[11.5px] text-muted-foreground">{intentMode ? 'Isi narasi, atau pilih “Tanpa suara” untuk intro/outro.' : 'Isi narasi, atau nyalakan “Tanpa narasi” untuk intro/outro.'}</span>}
    </div>
  );
  const soundBlock = intentMode ? (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-muted-foreground">Suara</span>
      <Segmented name="Suara" value={silent ? 'tanpa' : 'narasi'} disabled={locked}
        options={[{ value: 'narasi', label: 'Dengan narasi' }, { value: 'tanpa', label: 'Tanpa suara', hint: 'Intro/outro tanpa narasi' }]}
        onChange={v => edit('silent', setSilent)(v === 'tanpa')} />
    </div>
  ) : (
    <label className="flex items-center gap-2 text-[12.5px]">
      <Switch size="sm" checked={silent} disabled={locked} onCheckedChange={v => edit('silent', setSilent)(v)} aria-label="Tanpa narasi (intro/outro)" />
      Tanpa narasi (intro/outro)
    </label>
  );

  let preview;
  if (st?.status === 'done') {
    preview = <ClipPreview src={media.clip(p.id, shot.id, st.jobId ?? '')} poster={poster.shot(p.id, shot.id, playerPosterWidth(PREVIEW_H, board.aspect), st.jobId)} label={`Klip ${shot.id}`} maxH={PREVIEW_H} />;
  } else if (frame?.status === 'done') {
    preview = <KeyframePreview src={sized(media.frame(p.id, shot.id, frame.mediaId ?? ''), playerPosterWidth(PREVIEW_H, board.aspect))} label={`Keyframe ${shot.id}`} />;
  } else {
    const working = st?.status === 'queued' || frame?.status === 'queued';
    preview = (
      <div className="flex h-40 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-[12px] text-muted-foreground">
        {working ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Film aria-hidden="true" className="size-4" />}
        {status.label}
      </div>
    );
  }

  return (
    <>
      <SheetHeader className="gap-0.5 border-b px-4 pt-4 pb-3">
        <SheetTitle className="text-[14px]">Shot {number} · {shot.id}</SheetTitle>
        <SheetDescription className="flex items-center gap-1.5 text-[12px]">
          <span className="truncate">{scene?.title ?? 'Tanpa scene'}</span>
          <span aria-hidden="true">·</span>
          <span className={TONE_TEXT[status.tone]}>{status.label}</span>
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-[13px]">
        {locked && <p role="status" className="text-[12px] text-muted-foreground">Sedang {(STATUS_LABEL[story.status] ?? story.status).toLowerCase()} — shot dikunci sampai selesai.</p>}
        <div className="flex justify-center">{preview}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {frame && <span>Keyframe: <span className="text-foreground/80">{takeLabel(frame)}</span></span>}
          <span>Klip: <span className="text-foreground/80">{takeLabel(st)}</span></span>
          {!!st?.attempts && <span className="tabular-nums">Take {st.attempts}</span>}
        </div>
        {error && <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">{error}</p>}
        {retake && <p className="rounded-md bg-muted px-2.5 py-1.5 text-[12px]">Take ulang: {retake}</p>}
        {p.error && <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">{p.error}</p>}

        {intentMode ? (
          <>
            <IntentFields shotId={shot.id} value={intent} onChange={editIntent} triggers={triggers} catalog={props.catalog} disabled={locked} required={converting} />
            {converting && (
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                <span className="min-w-0 flex-1">Saat disimpan, prompt lama diganti prompt yang disusun dari niat ini.</span>
                <Button type="button" size="xs" variant="ghost" onClick={() => { setConverting(false); setTouched(t => new Set([...t].filter(f => !(INTENT_KEYS as readonly string[]).includes(f)))); setIntent(upstream); }}>Tetap pakai prompt</Button>
              </div>
            )}
            {narrationBlock}
            {soundBlock}
            <PromptPreview projectId={p.id} shot={draftShot} konsisten={story.mode === 'konsisten'} />
          </>
        ) : (
          <>
            {narrationBlock}
            {soundBlock}
            {props.catalog ? (
              <div className="flex flex-wrap gap-2">
                <Choice label="Framing" showLabel size="sm" disabled={locked} value={setup.framing ?? ''} placeholder="Lain"
                  options={props.catalog.framings.map(f => ({ value: f.id, label: f.label }))}
                  onChange={v => edit('prompt', setPrompt)(setShotSetup(prompt, props.catalog!, v, setup.move ?? 'static'))} />
                <Choice label="Gerakan kamera" showLabel size="sm" disabled={locked} value={setup.move ?? ''} placeholder="Lain"
                  options={props.catalog.moves.map(m => ({ value: m.id, label: m.label }))}
                  onChange={v => edit('prompt', setPrompt)(setShotSetup(prompt, props.catalog!, setup.framing ?? 'medium', v))} />
              </div>
            ) : (
              <div className="flex gap-2" aria-busy="true" aria-label="Memuat pilihan kamera"><Skeleton className="h-12 w-32" /><Skeleton className="h-12 w-32" /></div>
            )}
          </>
        )}

        {!intentMode && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span id={`prompt-${shot.id}`} className="text-[12px] text-muted-foreground">Prompt (English)</span>
              {bible && (
                <Button type="button" size="xs" variant="glass" disabled={locked} onClick={startIntent}
                  title="Isi subjek, aksi dan keadaan; prompt disusun dari bible"><Sparkles /> Ubah ke niat</Button>
              )}
            </div>
            <textarea aria-labelledby={`prompt-${shot.id}`} rows={5} placeholder="Medium shot, the camera stays still. TOKEN does something in one clear action." value={prompt} disabled={locked} onChange={e => edit('prompt', setPrompt)(e.target.value)}
              className={cn(textareaClass, 'font-mono text-[12px]')} />
            {!prompt.trim() && <span className="text-[11.5px] text-destructive">Prompt tidak boleh kosong.</span>}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">Pemeran</span>
          <SceneCastChips projectId={p.id} story={story} cast={cast} label="Pemeran di shot ini" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 border-t px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" disabled={locked || busy || !dirty || invalid} onClick={() => void save()}><Save /> Simpan</Button>
          {konsisten && (
            <Button type="button" size="sm" variant="glass" disabled={locked || busy || !castReady || frame?.status === 'queued' || intentChanged}
              title={castReady ? undefined : 'Buat lembar karakter dulu (Buat keyframe scene)'}
              onClick={() => void p.redraw(shot.id, promptChanged ? prompt.trim() : undefined)}>
              <RefreshCw /> Gambar ulang keyframe · gratis
            </Button>
          )}
          <Button type="button" size="sm" variant="glass" disabled={locked || busy || dirty || st?.status === 'queued'} onClick={() => void p.render({ shot: shot.id })}>
            <Clapperboard /> Render shot ini · ±{CREDITS_PER_SHOT} kredit
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={locked || busy || board.shots.length <= 1} onClick={() => setConfirming(true)}
            className="ml-auto text-destructive hover:text-destructive"><Trash2 /> Hapus</Button>
        </div>
        {failed && dirty && !locked && <p role="status" className="text-[11.5px] font-medium text-foreground">Perubahanmu belum tersimpan — simpan lagi</p>}
        {dirty && !locked && !failed && <p className="text-[11.5px] text-muted-foreground">Ada perubahan belum disimpan — simpan dulu sebelum render.{konsisten && promptChanged ? ' Gambar ulang memakai prompt baru.' : ''}</p>}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus shot {shot.id}?</AlertDialogTitle>
            <AlertDialogDescription>Narasi, prompt dan take shot ini dihapus dari storyboard{scene ? ` scene "${scene.title}"` : ''}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>Hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ShotSheet(props: { shotId?: string; catalog?: Catalog; onClose: () => void }) {
  const { board } = useProject();
  const open = !!props.shotId && !!board?.shots.some(s => s.id === props.shotId);
  return (
    <Sheet open={open} onOpenChange={o => { if (!o) props.onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[420px]">
        {open && <ShotEditor key={props.shotId} shotId={props.shotId!} catalog={props.catalog} onClose={props.onClose} />}
      </SheetContent>
    </Sheet>
  );
}

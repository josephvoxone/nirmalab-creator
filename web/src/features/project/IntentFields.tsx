/**
 * Intent fields of a bible shot (spec goal 4): what the shot must do — subject, action, start and
 * end state, emotion, framing, camera move. The prompt is never typed here: the server compiles it
 * from these fields + the bible, and `PromptPreview` shows exactly what will be sent.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Choice, inputClass, textareaClass } from '../../ui/controls.js';
import { MentionTextarea, type MentionTriggers } from '../../ui/MentionTextarea.js';
import { describeError } from '../../ui/states.js';
import type { Catalog } from '../stories/catalog.js';
import { storiesApi, type CompiledPreview } from '../stories/storiesClient.js';
import type { Shot, ShotIntent } from './model.js';

export type Intent = ShotIntent;
export type IntentDraft = { subject: string; action: string; startState: string; endState: string; emotion: string; framing: string; move: string };
export const REQUIRED: Array<keyof IntentDraft> = ['subject', 'action', 'startState', 'endState'];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The shot's intent as form values (camera picks may sit on the shot in the drafter's shape). */
export function draftOf(shot: Shot): IntentDraft {
  const i: Partial<Intent> = shot.intent ?? {};
  const s = shot as Shot & { framing?: unknown; move?: unknown };
  return {
    subject: str(i.subject), action: str(i.action), startState: str(i.startState), endState: str(i.endState),
    emotion: str(i.emotion), framing: str(i.framing) || str(s.framing), move: str(i.move) || str(s.move)
  };
}

/** Form values → the intent stored on the shot (keeps fields this form does not edit, drops empty optionals). */
export function intentFrom(draft: IntentDraft, previous?: Partial<Intent>): Intent {
  const out: Intent = { ...(previous ?? {}), subject: draft.subject.trim(), action: draft.action.trim(), startState: draft.startState.trim(), endState: draft.endState.trim() };
  for (const key of ['emotion', 'framing', 'move'] as const) {
    const v = draft[key].trim();
    if (v) out[key] = v; else delete out[key];
  }
  return out;
}

export const sameDraft = (a: IntentDraft, b: IntentDraft) => (Object.keys(a) as Array<keyof IntentDraft>).every(k => a[k].trim() === b[k].trim());
export const missingSlots = (d: IntentDraft) => REQUIRED.filter(k => !d[k].trim());

/** Moved to mentions.ts; re-exported so existing imports keep working. */
export { mentionTriggers } from './mentions.js';

function Label(props: { id: string; text: string; required?: boolean; missing?: boolean }) {
  return (
    <span id={props.id} className={cn('text-[12px] text-muted-foreground', props.missing && 'text-destructive')}>
      {props.text}{props.required && <span aria-hidden="true"> *</span>}
    </span>
  );
}

export function IntentFields(props: {
  shotId: string; value: IntentDraft; onChange: (next: IntentDraft) => void; triggers: MentionTriggers;
  catalog?: Catalog; disabled?: boolean; required?: boolean;
}) {
  const v = props.value;
  const set = (key: keyof IntentDraft) => (text: string) => props.onChange({ ...v, [key]: text });
  const missing = new Set(props.required ? missingSlots(v) : []);
  // One rule for all four required slots: once the user has filled any of them, every empty one is flagged.
  const started = REQUIRED.some(k => !!v[k].trim());
  const flag = (k: keyof IntentDraft) => started && missing.has(k);
  const id = (k: string) => `intent-${k}-${props.shotId}`;
  return (
    <div role="group" aria-label="Niat shot" className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <Label id={id('subject')} text="Subjek" required={props.required} missing={flag('subject')} />
        <MentionTextarea ariaLabel="Subjek" rows={1} maxRows={3} value={v.subject} onChange={set('subject')} triggers={props.triggers} disabled={props.disabled} ariaInvalid={flag('subject')}
          placeholder="LARAS, or a concrete noun: an old wooden boat" className="text-[12.5px]" />
      </div>
      <div className="flex flex-col gap-1">
        <Label id={id('action')} text="Aksi" required={props.required} missing={flag('action')} />
        <MentionTextarea ariaLabel="Aksi" rows={1} maxRows={4} value={v.action} onChange={set('action')} triggers={props.triggers} disabled={props.disabled} ariaInvalid={flag('action')}
          placeholder="One action in English: lifts the lantern toward the door" className="text-[12.5px]" />
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label id={id('start')} text="Keadaan awal" required={props.required} missing={flag('startState')} />
          <textarea aria-labelledby={id('start')} rows={2} value={v.startState} disabled={props.disabled} aria-invalid={flag('startState') || undefined} onChange={e => set('startState')(e.target.value)}
            placeholder="First frame: lantern unlit on the floor" className={cn(textareaClass, 'min-h-0 resize-none text-[12.5px]')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label id={id('end')} text="Keadaan akhir" required={props.required} missing={flag('endState')} />
          <textarea aria-labelledby={id('end')} rows={2} value={v.endState} disabled={props.disabled} aria-invalid={flag('endState') || undefined} onChange={e => set('endState')(e.target.value)}
            placeholder="Last frame: lantern glowing at eye level" className={cn(textareaClass, 'min-h-0 resize-none text-[12.5px]')} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label id={id('emotion')} text="Emosi" />
        <input aria-labelledby={id('emotion')} value={v.emotion} disabled={props.disabled} onChange={e => set('emotion')(e.target.value)} maxLength={80}
          placeholder="mis. waspada lalu lega" className={cn(inputClass, 'text-[12.5px]')} />
      </div>
      {props.catalog ? (
        <div className="flex flex-wrap gap-2">
          <Choice label="Framing" showLabel size="sm" disabled={props.disabled} value={v.framing} placeholder="Medium (bawaan)"
            options={props.catalog.framings.map(f => ({ value: f.id, label: f.label }))} onChange={set('framing')} />
          <Choice label="Gerak kamera" showLabel size="sm" disabled={props.disabled} value={v.move} placeholder="Diam (bawaan)"
            options={props.catalog.moves.map(m => ({ value: m.id, label: m.label }))} onChange={set('move')} />
        </div>
      ) : (
        <div className="flex gap-2" aria-busy="true" aria-label="Memuat pilihan kamera"><Skeleton className="h-12 w-32" /><Skeleton className="h-12 w-32" /></div>
      )}
      <p className="text-[11.5px] text-muted-foreground">
        Tulis subjek, aksi dan keadaan dalam English — masuk ke prompt. Ketik <kbd className="font-mono">@</kbd> untuk karakter, <kbd className="font-mono">#</kbd> untuk lokasi.
        {props.required && missing.size > 0 && <span className="text-foreground"> Wajib diisi: subjek, aksi, keadaan awal dan akhir.</span>}
      </p>
    </div>
  );
}

const DEBOUNCE_MS = 400;

/**
 * "Prompt yang dikirim": the compiled prompts of the shot as edited (POST compile-shot, 400 ms after
 * the last keystroke). Issues are render-time problems — a draft still saves.
 */
export function PromptPreview(props: { projectId: string; shot: Record<string, unknown> & { id: string }; konsisten: boolean }) {
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const key = JSON.stringify(props.shot);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ key: string; data?: CompiledPreview; error?: unknown }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.compileShot(props.projectId, JSON.parse(key)).then(
        data => { if (alive) setState({ key, data }); },
        error => { if (alive) setState(s => ({ key, data: s?.data, error })); }
      );
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(t); };
  }, [api, props.projectId, key, attempt]);

  const data = state?.data;
  const pending = !state || state.key !== key;
  const issues = data?.issues ?? [];
  const warnings = data?.warnings ?? [];
  const bodyId = `prompt-${props.shot.id}`;
  return (
    <div className="flex flex-col gap-1.5">
      {state?.error != null && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          <span className="min-w-0 flex-1">Pratinjau prompt gagal dimuat: {describeError(state.error)}</span>
          <Button type="button" size="xs" variant="ghost" onClick={() => setAttempt(a => a + 1)}><RotateCcw /> Coba lagi</Button>
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-(--brand-muted) px-2.5 py-1.5 text-[12px]">
          <span className="flex items-center gap-1.5 font-medium"><AlertTriangle aria-hidden="true" className="size-3.5" /> Belum siap dirender — tetap bisa disimpan</span>
          <ul aria-label="Masalah prompt" className="flex flex-col gap-0.5 text-muted-foreground">
            {issues.map(i => <li key={i}>· {i}</li>)}
          </ul>
        </div>
      )}
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(o => !o)}
        className="flex w-fit items-center gap-1 rounded-md text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60">
        <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Prompt yang dikirim
        {pending && <span className="text-[11px] text-muted-foreground/70">· memperbarui…</span>}
      </button>
      {open && (
        <div id={bodyId} role="region" aria-label="Prompt yang dikirim" className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-(--field) px-2.5 py-2">
          {!data ? (
            <div aria-busy="true" aria-label="Memuat prompt" className="flex flex-col gap-1"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></div>
          ) : !data.videoPrompt && !data.imagePrompt ? (
            <p className="text-[12px] text-muted-foreground">Belum ada prompt — lengkapi niat di atas.</p>
          ) : (
            <>
              {props.konsisten && data.imagePrompt && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground/80">Keyframe</span>
                  <p className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{data.imagePrompt}</p>
                </div>
              )}
              {data.videoPrompt && (
                <div className="flex flex-col gap-0.5">
                  {props.konsisten && <span className="text-[11px] text-muted-foreground/80">Klip</span>}
                  <p className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{data.videoPrompt}</p>
                </div>
              )}
              {warnings.length > 0 && <ul aria-label="Catatan prompt" className="text-[11.5px] text-muted-foreground">{warnings.map(w => <li key={w}>· {w}</li>)}</ul>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

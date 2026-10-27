/**
 * The project assistant (spec goals 8 and 13): history on mount, a streamed reply per message,
 * change chips with undo, one-click pending runs, image attachments (button, paste, drag-drop).
 * After every turn that moved the board's revision, `onChanged` refetches the project tabs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowDown, ImagePlus, PanelRightClose, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useSession } from '../../lib/session.js';
import { ApiError } from '../../lib/api.js';
import { describeError } from '../../ui/states.js';
import { uploadProblem, type Story } from '../stories/storiesClient.js';
import { mentionTriggers } from '../project/IntentFields.js';
import type { Board } from '../project/model.js';
import {
  assistantApi, FINAL_CONFIRM_CODES, MAX_ATTACHMENTS, NOT_CONFIGURED, slashItems, suggestions,
  type SendBody, type Turn, type TurnAttachment, type TurnChange, type TurnPending
} from './assistantClient.js';
import { Composer, COMPOSER_ID, type Draft } from './Composer.js';
import { IconTip } from './IconTip.js';
import { MessageList, type LiveState } from './MessageList.js';
import type { PendingView } from './PendingCard.js';
import type { SseEvent } from './sse.js';

export const NOT_CONFIGURED_LINE = 'Asisten butuh model teks — atur di Pengaturan › Provider.';
const NEAR_BOTTOM_PX = 80;
let seq = 0;
const localId = (p: string) => `local-${p}-${++seq}`;
const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';

/**
 * The stored history after a turn, keeping what the server does not have: a turn refused before it
 * started (a 409 before the stream), or one still being saved. Each such turn keeps its place: it
 * goes right after the nearest earlier turn the server has (or first, when there is none), never
 * to the end. Assistant turns match by the id from the `turn` event; an optimistic user bubble is
 * dropped when the server holds the reply after it and, just before that reply, a user turn with
 * the same words (the server saved this very message).
 */
export function reconcile(current: Turn[], stored: Turn[]): Turn[] {
  const index = new Map(stored.map((t, i) => [t.id, i]));
  const after = new Map<string | undefined, Turn[]>();
  let anchor: string | undefined;
  current.forEach((t, i) => {
    if (index.has(t.id)) { anchor = t.id; return; }
    const next = current[i + 1];
    const reply = next ? index.get(next.id) : undefined;
    if (t.role === 'user' && reply !== undefined) {
      const saved = stored[reply - 1];
      if (saved?.role === 'user' && saved.text.trim() === t.text.trim()) return;
    }
    after.set(anchor, [...(after.get(anchor) ?? []), t]);
  });
  const out = [...(after.get(undefined) ?? [])];
  for (const t of stored) out.push(t, ...(after.get(t.id) ?? []));
  return out;
}

export type AssistantPanelProps = {
  story: Story;
  board: Board;
  /** Called after a turn that changed the project (and after an undo): refetch the tabs. */
  onChanged: () => void;
  /** The top bar's hide/close button. */
  onClose?: () => void;
  closeLabel?: string;
  /** `x` in the sheet (closes it), the panel icon in the column (hides it). */
  closeIcon?: 'x' | 'panel';
  /** Put the cursor in the composer on mount (the sheet). */
  autoFocus?: boolean;
  /** Move focus to the close/hide button (the column was just shown), then call `onFocused`. */
  focusClose?: boolean;
  onFocused?: () => void;
};

function HistorySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Memuat percakapan" className="flex flex-col gap-5">
      <div className="flex justify-end"><Skeleton className="h-8 w-3/5 rounded-2xl" /></div>
      <div className="flex flex-col gap-1.5"><Skeleton className="h-3 w-20" /><Skeleton className="h-3 w-11/12" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-2/3" /></div>
      <div className="flex justify-end"><Skeleton className="h-8 w-2/5 rounded-2xl" /></div>
    </div>
  );
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { fetchImpl } = useSession();
  const api = useMemo(() => assistantApi(fetchImpl), [fetchImpl]);
  const storyId = props.story.id;
  const location = useLocation();

  const [turns, setTurns] = useState<Turn[]>();
  const [loadError, setLoadError] = useState<unknown>();
  const [configured, setConfigured] = useState(true);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [pendingState, setPendingState] = useState<Record<string, Partial<PendingView>>>({});
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [problem, setProblem] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [away, setAway] = useState(false);
  const abort = useRef<AbortController>(undefined);
  const running = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const closeWrap = useRef<HTMLSpanElement>(null);
  /** Uploads still wanted, by draft key; removing a chip aborts and forgets its upload. */
  const uploads = useRef(new Map<string, AbortController>());
  /** Local blob previews by draft key, revoked once the sized thumbnail shows (or the draft goes). */
  const previews = useRef(new Map<string, string>());
  const nearBottom = useRef(true);
  const retries = useRef(new Map<string, SendBody & { echo: Pick<Turn, 'text' | 'attachments'> }>());
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;
  const revRef = useRef(props.story.rev);
  revRef.current = props.story.rev;

  const load = useCallback(async (background = false) => {
    if (!background) { setLoadError(undefined); setTurns(undefined); }
    try {
      const h = await api.history(storyId);
      // A refresh that lands while the next reply streams would drop its optimistic messages.
      if (background && running.current) return;
      setConfigured(h.configured);
      setTurns(cur => (background && cur ? reconcile(cur, h.turns) : h.turns));
    } catch (error) {
      if (!background) setLoadError(error);
    }
  }, [api, storyId]);
  useEffect(() => { void load(); }, [load]);

  // Not configured: look again when the user comes back — the window regains focus, or the
  // settings modal (opened over this page with `background`) closes and navigates here again.
  useEffect(() => {
    if (configured) return undefined;
    const again = () => void load(true);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [configured, load]);
  const seenKey = useRef(location.key);
  useEffect(() => {
    if (seenKey.current === location.key) return;
    seenKey.current = location.key;
    if (!configured) void load(true);
  }, [location.key, configured, load]);

  const dropPreview = (key: string) => {
    const url = previews.current.get(key);
    if (url) URL.revokeObjectURL?.(url);
    previews.current.delete(key);
  };
  useEffect(() => {
    const pending = uploads.current;
    const blobs = previews.current;
    return () => {
      for (const c of pending.values()) c.abort();
      for (const url of blobs.values()) URL.revokeObjectURL?.(url);
    };
  }, []);

  const triggers = useMemo(() => ({ ...mentionTriggers(storyId, props.board, props.story), '/': slashItems(props.board) }), [storyId, props.board, props.story]);
  const chips = useMemo(() => suggestions(props.board, props.story), [props.board, props.story]);

  // Follow the reply while the reader is at the bottom; otherwise offer "Ke bawah".
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
    else setAway(true);
  }, [turns, live]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom.current) setAway(false);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' });
    nearBottom.current = true;
    setAway(false);
  };
  const focusComposer = () => requestAnimationFrame(() => (document.getElementById(COMPOSER_ID) as HTMLTextAreaElement | null)?.focus());
  // On mount only: the sheet just opened (a later prop change must not steal the cursor).
  const autoFocus = useRef(props.autoFocus);
  useEffect(() => { if (autoFocus.current) focusComposer(); }, []);
  const { focusClose, onFocused } = props;
  useEffect(() => {
    if (!focusClose) return;
    closeWrap.current?.querySelector('button')?.focus();
    onFocused?.();
  }, [focusClose, onFocused]);

  const patchTurn = (id: string, fn: (t: Turn) => Turn) => setTurns(ts => ts?.map(t => (t.id === id ? fn(t) : t)));
  const patchLive = (id: string, fn: (l: LiveState) => LiveState) => setLive(l => ({ ...l, [id]: fn(l[id] ?? { steps: [], streaming: false }) }));

  /** One streamed turn: optimistic user bubble, then events into a new assistant message. */
  const run = async (body: SendBody, echo: Pick<Turn, 'text' | 'attachments'>, confirming?: string) => {
    const controller = new AbortController();
    abort.current = controller;
    const startRev = revRef.current;
    const userId = localId('u');
    let turnId = localId('a');
    const now = new Date().toISOString();
    setTurns(ts => [...(ts ?? []), { id: userId, at: now, role: 'user', ...echo }, { id: turnId, at: now, role: 'assistant', text: '', changes: [], pending: [] }]);
    setLive(l => ({ ...l, [turnId]: { steps: [], streaming: true } }));
    nearBottom.current = true;
    setAway(false);
    setStreaming(true);
    running.current = true;
    if ('message' in body) retries.current.set(turnId, { ...body, echo });
    let doneRev: number | undefined;
    let changed = false;

    const onEvent = ({ event, data }: SseEvent) => {
      const d = (data ?? {}) as Record<string, unknown>;
      const id = turnId;
      if (event === 'turn' && typeof d.id === 'string') {
        const next = d.id;
        turnId = next;
        setTurns(ts => ts?.map(t => (t.id === id ? { ...t, id: next } : t)));
        setLive(l => { const n = { ...l, [next]: l[id] ?? { steps: [], streaming: true } }; delete n[id]; return n; });
        const r = retries.current.get(id);
        if (r) { retries.current.delete(id); retries.current.set(next, r); }
      } else if (event === 'step' && typeof d.label === 'string') {
        const label = d.label.replace(/…$/, '');
        patchLive(id, l => ({ ...l, steps: [...l.steps, label] }));
      } else if (event === 'delta' && typeof d.text === 'string') {
        const piece = d.text;
        patchTurn(id, t => ({ ...t, text: t.text + piece }));
      } else if (event === 'change' && typeof d.label === 'string' && typeof d.undoId === 'string') {
        changed = true;
        const c: TurnChange = { label: d.label, undoId: d.undoId };
        patchTurn(id, t => ({ ...t, changes: [...(t.changes ?? []), c] }));
      } else if (event === 'pending' && typeof d.id === 'string') {
        const p = d as unknown as TurnPending;
        patchTurn(id, t => {
          const list = t.pending ?? [];
          const at = list.findIndex(x => x.id === p.id);
          const entry: TurnPending = { id: p.id, label: p.label, estimate: p.estimate ?? {}, createdAt: new Date().toISOString(), ...(p.superseded ? { superseded: true } : {}) };
          return { ...t, pending: at === -1 ? [...list, entry] : list.map((x, i) => (i === at ? { ...x, ...entry } : x)) };
        });
      } else if (event === 'error') {
        const message = typeof d.message === 'string' ? d.message : 'Asisten gagal — coba lagi.';
        const code = typeof d.code === 'string' ? d.code : undefined;
        if (code === NOT_CONFIGURED) setConfigured(false);
        patchLive(id, l => ({ ...l, error: { message, ...(code ? { code } : {}) }, canRetry: 'message' in body && code !== NOT_CONFIGURED && code !== 'CANCELLED' }));
      } else if (event === 'done') {
        if (typeof d.rev === 'number') doneRev = d.rev;
      }
    };

    try {
      await api.send(storyId, body, onEvent, controller.signal);
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) {
        patchLive(turnId, l => ({ ...l, error: { message: 'Dihentikan.', code: 'CANCELLED' } }));
      } else {
        const code = error instanceof ApiError ? error.code : undefined;
        if (confirming && code && FINAL_CONFIRM_CODES.has(code)) {
          // The run never started: drop the placeholder pair and say why on the card itself.
          setTurns(ts => ts?.filter(t => t.id !== userId && t.id !== turnId));
          setPendingState(s => ({ ...s, [confirming]: { refused: describeError(error), final: true, used: undefined } }));
        } else {
          if (code === NOT_CONFIGURED) setConfigured(false);
          if (confirming) setPendingState(s => ({ ...s, [confirming]: { used: undefined, refused: describeError(error) } }));
          patchLive(turnId, l => ({ ...l, error: { message: describeError(error), ...(code ? { code } : {}) }, canRetry: 'message' in body }));
        }
      }
    } finally {
      patchLive(turnId, l => ({ ...l, streaming: false }));
      if (abort.current === controller) abort.current = undefined;
      running.current = false;
      setStreaming(false);
    }
    if (changed || (doneRev !== undefined && doneRev !== startRev)) onChanged.current();
    if (doneRev !== undefined) void load(true);
  };

  const send = async (message = text) => {
    if (running.current || drafts.some(d => d.status === 'uploading')) return;
    const ready = drafts.filter(d => d.upload);
    const trimmed = message.trim();
    if (!trimmed && !ready.length) return;
    const attachments: TurnAttachment[] = ready.map(d => ({ id: d.upload!.id, url: d.upload!.url, w: d.upload!.w, h: d.upload!.h }));
    // The server needs words with every message; an image on its own gets a plain request.
    const words = trimmed || 'Pakai gambar terlampir.';
    setText('');
    for (const d of drafts) dropPreview(d.key);
    setDrafts([]);
    setProblem(undefined);
    focusComposer();
    await run({ message: words, ...(attachments.length ? { attachments: attachments.map(a => a.id) } : {}) }, { text: words, ...(attachments.length ? { attachments } : {}) });
  };

  const retry = (turnId: string) => {
    const r = retries.current.get(turnId);
    if (!r || running.current) return;
    const { echo, ...body } = r;
    void run(body, echo);
  };

  const confirm = async (pendingId: string, label: string) => {
    if (running.current) return;
    setPendingState(s => ({ ...s, [pendingId]: { used: new Date().toISOString() } }));
    await run({ confirm: pendingId }, { text: `Jalankan: ${label}` }, pendingId);
  };

  const undo = async (undoId: string): Promise<string | undefined> => {
    try {
      await api.undo(storyId, undoId);
      setTurns(ts => ts?.map(t => (t.changes?.some(c => c.undoId === undoId) ? { ...t, changes: t.changes.map(c => (c.undoId === undoId ? { ...c, undone: true } : c)) } : t)));
      onChanged.current();
      return undefined;
    } catch (error) {
      return describeError(error);
    }
  };

  const stop = () => abort.current?.abort();

  const addFiles = (files: File[]) => {
    setProblem(undefined);
    const room = MAX_ATTACHMENTS - drafts.length;
    const problems: string[] = [];
    const ok: File[] = [];
    for (const f of files) {
      const why = uploadProblem(f);
      if (why) problems.push(`${f.name}: ${why}`);
      else ok.push(f);
    }
    if (ok.length > room) problems.push(`Maksimal ${MAX_ATTACHMENTS} gambar per pesan.`);
    const take = ok.slice(0, Math.max(0, room));
    if (problems.length) setProblem(problems.join(' '));
    for (const f of take) {
      const key = localId('f');
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : undefined;
      if (preview) previews.current.set(key, preview);
      const controller = new AbortController();
      uploads.current.set(key, controller);
      setDrafts(ds => [...ds, { key, name: f.name, status: 'uploading', ...(preview ? { preview } : {}) }]);
      api.upload(storyId, f, controller.signal).then(
        upload => {
          if (!uploads.current.delete(key)) return;
          setDrafts(ds => ds.map(d => (d.key === key ? { ...d, status: 'done', upload } : d)));
        },
        error => {
          // A chip removed meanwhile: its result (or the abort) no longer matters.
          if (!uploads.current.delete(key)) return;
          dropPreview(key);
          setDrafts(ds => ds.filter(d => d.key !== key));
          setProblem(`${f.name}: ${describeError(error)}`);
        }
      );
    }
  };
  const removeDraft = (key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    dropPreview(key);
    setDrafts(ds => ds.filter(d => d.key !== key));
  };
  /** The sized thumbnail has loaded: swap the local preview out and free it. */
  const thumbLoaded = (key: string) => {
    dropPreview(key);
    setDrafts(ds => ds.map(d => {
      if (d.key !== key || !d.preview) return d;
      const { preview: _gone, ...rest } = d;
      return rest;
    }));
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dropProps = configured ? {
    onDragEnter: (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    }
  } : {};

  const settingsState = { background: (location.state as { background?: unknown } | null)?.background ?? location };
  const empty = turns && turns.length === 0;

  return (
    <section aria-label="Asisten proyek" {...dropProps} className="relative flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
        <h2 className="text-[13px] font-medium">Asisten proyek</h2>
        {props.onClose && (
          <span ref={closeWrap} className="ml-auto"><IconTip label={props.closeLabel ?? 'Sembunyikan asisten'} onClick={props.onClose}>{props.closeIcon === 'x' ? <X /> : <PanelRightClose />}</IconTip></span>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
          {loadError ? (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-[12.5px]">
              <span className="font-medium text-destructive">Percakapan gagal dimuat</span>
              <span className="text-muted-foreground">{describeError(loadError)}</span>
              <Button size="xs" variant="glass" onClick={() => void load()}><RotateCcw /> Coba lagi</Button>
            </div>
          ) : !turns ? (
            <HistorySkeleton />
          ) : empty ? (
            <div className="flex h-full flex-col justify-end gap-2.5 pb-1">
              <p className="text-[13px] text-muted-foreground">Tanya atau suruh apa saja tentang proyek ini.</p>
              {configured && (
                <div className="flex flex-wrap gap-1.5" aria-label="Contoh perintah">
                  {chips.map(c => (
                    <button key={c} type="button" onClick={() => { setText(c); focusComposer(); }}
                      className="glass-control h-7 rounded-full px-3 text-[12px] text-foreground/90 outline-none transition-colors hover:bg-foreground/[0.12] focus-visible:ring-1 focus-visible:ring-ring/60">
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <MessageList turns={turns} live={live} pendingState={pendingState} skipped={skipped} busy={streaming}
              onUndo={undo} onRun={confirm} onSkip={id => setSkipped(s => new Set(s).add(id))} onRetry={retry} />
          )}
        </div>

        {away && (
          <button type="button" onClick={toBottom}
            className="glass-control absolute bottom-2 left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1 rounded-full px-2.5 text-[12px] shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
            <ArrowDown aria-hidden="true" className="size-3.5" /> Ke bawah
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3">
        {configured ? (
          <Composer value={text} onChange={v => { setText(v); if (problem) setProblem(undefined); }} triggers={triggers} drafts={drafts}
            onRemove={removeDraft} onLoaded={thumbLoaded} onFiles={addFiles} problem={problem} streaming={streaming} onSend={() => void send()} onStop={stop} />
        ) : (
          <p className="rounded-lg border border-border/70 px-3 py-2.5 text-[12.5px] text-muted-foreground">
            Asisten butuh model teks — atur di{' '}
            <Link to="/pengaturan/provider" state={settingsState} className="text-foreground underline underline-offset-2 hover:text-foreground/80">Pengaturan › Provider</Link>.
          </p>
        )}
      </div>

      {dragging && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-1.5 z-20 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ring/60 bg-background/85 text-[13px] text-foreground')}>
          <ImagePlus className="size-5 text-muted-foreground" /> Lepas gambar di sini
        </div>
      )}
    </section>
  );
}

export default AssistantPanel;

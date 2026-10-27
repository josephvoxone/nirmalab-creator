/**
 * Where the assistant lives on the project page. From `lg` it is a sticky right column beside the
 * tabs, a fixed 380 px wide, hidden or shown from the header and remembered in localStorage
 * (`nc.assistant.open`). Below `lg` a header button "Asisten" opens it as a sheet from the right.
 * The panel itself (markdown renderer included) loads lazily the first time it is shown; a chunk
 * that fails to load shows an inline error with "Coba lagi" and the rest of the page keeps working.
 */
import { createPortal } from 'react-dom';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { MessageSquare, PanelRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '../../ui/states.js';
import { RIGHT_PANEL_ID, TOPBAR_SLOT_ID, useShellSlot } from '../../shell/slots.js';
import { IconTip } from './IconTip.js';
import { COMPOSER_ID } from './ids.js';
import type { AssistantPanelProps } from './AssistantPanel.js';
import type { Story } from '../stories/storiesClient.js';
import type { Board } from '../project/model.js';

export type PanelLoader = () => Promise<{ default: ComponentType<AssistantPanelProps> }>;
const loadPanel: PanelLoader = () => import('./AssistantPanel.js');
/** One lazy component per loader, so a remount (the sheet reopening) does not suspend again. */
const lazyPanels = new Map<PanelLoader, LazyExoticComponent<ComponentType<AssistantPanelProps>>>();
function lazyPanel(load: PanelLoader) {
  let panel = lazyPanels.get(load);
  if (!panel) { panel = lazy(load); lazyPanels.set(load, panel); }
  return panel;
}

export const OPEN_KEY = 'nc.assistant.open';
const LG = '(min-width: 64rem)';
/** Below this the page would get narrow beside sidebar + column: it starts hidden (one click shows it). */
const ROOMY = '(min-width: 90rem)';

const matches = (query: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

function useMedia(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const mql = window.matchMedia(query);
    mql.addEventListener?.('change', notify);
    return () => mql.removeEventListener?.('change', notify);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matches(query), () => false);
}

function readOpen(): boolean {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage blocked: fall through to the default */ }
  return matches(ROOMY);
}

function writeOpen(open: boolean) {
  try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* not remembered, still works */ }
}

export type AssistantDock = {
  wide: boolean; open: boolean; sheet: boolean; toggle: () => void; setSheet: (v: boolean) => void;
  /** After a toggle: focus "Tampilkan asisten" (`show`) or the column's "Sembunyikan asisten" (`hide`). */
  focus?: 'show' | 'hide'; clearFocus?: () => void;
};

export function useAssistantDock(): AssistantDock {
  const wide = useMedia(LG);
  const [open, setOpen] = useState(readOpen);
  const [sheet, setSheet] = useState(false);
  const [focus, setFocus] = useState<'show' | 'hide'>();
  const toggle = useCallback(() => {
    const next = !open;
    writeOpen(next);
    setOpen(next);
    setFocus(next ? 'hide' : 'show');
  }, [open]);
  const clearFocus = useCallback(() => setFocus(undefined), []);
  return { wide, open, sheet, toggle, setSheet, focus, clearFocus };
}

/**
 * The header control. lg+: "Tampilkan asisten" while the column is hidden (the column's own top
 * bar holds "Sembunyikan asisten", so one control shows per state). Below lg: "Asisten" opens the sheet.
 */
export function AssistantToggle(props: { dock: AssistantDock }) {
  const { dock } = props;
  const wrap = useRef<HTMLSpanElement>(null);
  // In the shell the control sits at the right end of the top bar, above where the column opens.
  const slot = useShellSlot(TOPBAR_SLOT_ID);
  const showing = dock.wide && !dock.open;
  useEffect(() => {
    if (!showing || dock.focus !== 'show') return;
    wrap.current?.querySelector('button')?.focus();
    dock.clearFocus?.();
  }, [showing, dock]);
  const control = !dock.wide
    ? <Button size="sm" variant="glass" onClick={() => dock.setSheet(true)} aria-haspopup="dialog"><MessageSquare /> Asisten</Button>
    : dock.open ? null : <span ref={wrap} className="contents"><IconTip label="Tampilkan asisten" onClick={dock.toggle}><PanelRight /></IconTip></span>;
  if (!control) return null;
  return slot ? createPortal(control, slot) : control;
}

function PanelFallback() {
  return (
    <div role="status" aria-busy="true" aria-label="Memuat asisten" className="flex h-full flex-col gap-3 p-3">
      <Skeleton className="h-4 w-28" />
      <div className="flex-1" />
      <Skeleton className="h-16 w-full rounded-2xl" />
    </div>
  );
}

/** Catches a chunk that fails to load (or a panel that throws) so only the assistant shows an error. */
class PanelBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean; error?: unknown }> {
  state: { failed: boolean; error?: unknown } = { failed: false };
  static getDerivedStateFromError(error: unknown) { return { failed: true, error }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="m-3 flex flex-col items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-[12.5px]">
        <span className="font-medium text-destructive">Asisten gagal dimuat</span>
        <span className="text-muted-foreground">{describeError(this.state.error)}</span>
        <Button size="xs" variant="glass" onClick={() => { this.setState({ failed: false, error: undefined }); this.props.onRetry(); }}><RotateCcw /> Coba lagi</Button>
      </div>
    );
  }
}

/** The lazy panel behind its boundary; "Coba lagi" drops the failed lazy component and imports again. */
function PanelSlot(props: AssistantPanelProps & { load?: PanelLoader }) {
  const { load = loadPanel, ...panel } = props;
  const [, setAttempt] = useState(0);
  const Panel = lazyPanel(load);
  const retry = () => { lazyPanels.delete(load); setAttempt(n => n + 1); };
  return (
    <PanelBoundary onRetry={retry}>
      <Suspense fallback={<PanelFallback />}><Panel {...panel} /></Suspense>
    </PanelBoundary>
  );
}

type Shared = { dock: AssistantDock; story: Story; board: Board; onChanged: () => void; /** Tests: a loader that fails. */ load?: PanelLoader };

export const WIDTH_KEY = 'nc.assistant.width';
export const DEFAULT_WIDTH = 380;
export const MIN_WIDTH = 320;
const MAX_WIDTH = 760;
/** The page keeps at least this much beside the panel (sidebar + a usable project view). */
const PAGE_ROOM = 560;
const STEP = 16;

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (typeof window === 'undefined' ? 1440 : window.innerWidth) - PAGE_ROOM));
const clampWidth = (w: number) => Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)));

function readWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* storage blocked */ }
  return DEFAULT_WIDTH;
}

function writeWidth(w: number) {
  try { window.localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* not remembered, still works */ }
}

/** Panel width: remembered, clamped to what the window leaves (re-clamped when the window resizes). */
function usePanelWidth() {
  const [stored, setStored] = useState(readWidth);
  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick(t => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /** `save: false` while dragging (state only); the drag's end, keys and reset are remembered. */
  const set = useCallback((w: number, save = true) => { const next = clampWidth(w); setStored(next); if (save) writeWidth(next); }, []);
  return { width: clampWidth(stored), set };
}

/**
 * The panel's left edge: drag to resize (pointer), ← → / Home / End from the keyboard, double-click
 * back to the default. A thin line that brightens on hover/drag, a wider invisible hit area.
 */
function ResizeHandle(props: { width: number; onWidth: (w: number, save?: boolean) => void }) {
  const { width, onWidth } = props;
  const [dragging, setDragging] = useState(false);
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return; // primary button / touch / pen only
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    setDragging(true);
    const body = document.body.style;
    const before = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = 'col-resize';
    body.userSelect = 'none';
    // The panel is on the right: moving the edge left (smaller x) makes it wider.
    const move = (ev: MouseEvent) => onWidth(w0 + (x0 - ev.clientX), false);
    const end = (ev: MouseEvent) => {
      onWidth(w0 + (x0 - ev.clientX));
      setDragging(false);
      body.cursor = before.cursor;
      body.userSelect = before.userSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowLeft' ? width + STEP : e.key === 'ArrowRight' ? width - STEP : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? maxWidth() : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onWidth(next);
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Ubah lebar asisten" tabIndex={0}
      aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth()}
      title="Geser untuk mengubah lebar · klik dua kali untuk ukuran awal"
      onPointerDown={start} onKeyDown={onKey} onDoubleClick={() => onWidth(DEFAULT_WIDTH)}
      className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none">
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-[5px] w-0.5 rounded-full transition-colors duration-150',
        dragging ? 'bg-foreground/60' : 'bg-transparent group-hover:bg-foreground/35 group-focus-visible:bg-foreground/50')} />
    </div>
  );
}

/** True when the shell has the right column: the page then keeps its normal width (the column is not inside it). */
export function useDockedInShell(): boolean {
  return !!useShellSlot(RIGHT_PANEL_ID);
}

/**
 * lg+: the column. In the shell it is a full-height panel beside `main`, level with the top bar, and
 * the page shrinks (ChatGPT-style); alone (tests) it sits inline beside the tabs. Mounted once
 * shown, then only hidden, so a reply keeps streaming.
 */
export function AssistantColumn(props: Shared) {
  const { dock } = props;
  const slot = useShellSlot(RIGHT_PANEL_ID);
  const { width, set: setWidth } = usePanelWidth();
  const [shown, setShown] = useState(dock.open);
  if (dock.open && !shown) setShown(true);
  if (!dock.wide || !shown) return null;
  const panel = (
    <aside hidden={!dock.open} aria-label="Kolom asisten" style={slot ? { width } : undefined}
      className={slot
        ? 'relative flex h-svh shrink-0 flex-col border-l bg-sidebar animate-in fade-in-0 slide-in-from-right-6 duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
        : 'glass-panel sticky top-2 flex h-[calc(100svh-4rem)] w-[380px] shrink-0 flex-col overflow-hidden rounded-xl'}>
      {slot && <ResizeHandle width={width} onWidth={setWidth} />}
      {/* Keyed by project: drafts, history and streams never carry over to another project. */}
      <PanelSlot key={props.story.id} load={props.load} story={props.story} board={props.board} onChanged={props.onChanged} docked={!!slot}
        onClose={dock.toggle} closeLabel="Sembunyikan asisten" focusClose={dock.open && dock.focus === 'hide'} onFocused={dock.clearFocus} />
    </aside>
  );
  return slot ? createPortal(panel, slot) : panel;
}

/** Below lg: the same panel in a sheet from the right (full height, up to 420 px wide). */
export function AssistantSheet(props: Shared) {
  const { dock } = props;
  if (dock.wide) return null;
  return (
    <Sheet open={dock.sheet} onOpenChange={dock.setSheet}>
      {/* The composer gets the cursor: now if the panel is loaded, else the panel focuses it on mount. */}
      <SheetContent side="right" showCloseButton={false} aria-label="Asisten proyek" initialFocus={() => document.getElementById(COMPOSER_ID) ?? false}
        className="w-[min(100vw,420px)] max-w-none gap-0 p-0 data-[side=right]:w-[min(100vw,420px)] data-[side=right]:sm:max-w-none">
        <PanelSlot key={props.story.id} load={props.load} story={props.story} board={props.board} onChanged={props.onChanged}
          onClose={() => dock.setSheet(false)} closeLabel="Tutup asisten" closeIcon="x" autoFocus />
      </SheetContent>
    </Sheet>
  );
}

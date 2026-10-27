/**
 * Where the assistant lives on the project page. From `lg` it is a sticky right column beside the
 * tabs, a fixed 380 px wide, hidden or shown from the header and remembered in localStorage
 * (`nc.assistant.open`). Below `lg` a header button "Asisten" opens it as a sheet from the right.
 * The panel itself (markdown renderer included) loads lazily the first time it is shown; a chunk
 * that fails to load shows an inline error with "Coba lagi" and the rest of the page keeps working.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { MessageSquare, PanelRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '../../ui/states.js';
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
/** Below this the tabs would get narrow beside the column: it starts hidden (one click shows it). */
const ROOMY = '(min-width: 80rem)';

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
  const showing = dock.wide && !dock.open;
  useEffect(() => {
    if (!showing || dock.focus !== 'show') return;
    wrap.current?.querySelector('button')?.focus();
    dock.clearFocus?.();
  }, [showing, dock]);
  if (!dock.wide) {
    return <Button size="sm" variant="glass" onClick={() => dock.setSheet(true)} aria-haspopup="dialog"><MessageSquare /> Asisten</Button>;
  }
  if (dock.open) return null;
  return <span ref={wrap} className="contents"><IconTip label="Tampilkan asisten" onClick={dock.toggle}><PanelRight /></IconTip></span>;
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

/** lg+: the sticky column. Mounted once shown, then only hidden, so a reply keeps streaming. */
export function AssistantColumn(props: Shared) {
  const { dock } = props;
  const [shown, setShown] = useState(dock.open);
  if (dock.open && !shown) setShown(true);
  if (!dock.wide || !shown) return null;
  return (
    <aside hidden={!dock.open} aria-label="Kolom asisten"
      className="glass-panel sticky top-2 flex h-[calc(100svh-4rem)] w-[380px] shrink-0 flex-col overflow-hidden rounded-xl">
      {/* Keyed by project: drafts, history and streams never carry over to another project. */}
      <PanelSlot key={props.story.id} load={props.load} story={props.story} board={props.board} onChanged={props.onChanged}
        onClose={dock.toggle} closeLabel="Sembunyikan asisten" focusClose={dock.open && dock.focus === 'hide'} onFocused={dock.clearFocus} />
    </aside>
  );
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

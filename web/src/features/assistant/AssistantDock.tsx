/**
 * Where the assistant lives on the project page. From `lg` it is a sticky right column beside the
 * tabs (380 px, 340–420), hidden or shown from the header and remembered in localStorage
 * (`nc.assistant.open`). Below `lg` a header button "Asisten" opens it as a sheet from the right.
 * The panel itself (markdown renderer included) loads lazily the first time it is shown.
 */
import { lazy, Suspense, useCallback, useState, useSyncExternalStore } from 'react';
import { MessageSquare, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { IconTip } from './IconTip.js';
import type { Story } from '../stories/storiesClient.js';
import type { Board } from '../project/model.js';

const AssistantPanel = lazy(() => import('./AssistantPanel.js'));

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

export type AssistantDock = { wide: boolean; open: boolean; sheet: boolean; toggle: () => void; setSheet: (v: boolean) => void };

export function useAssistantDock(): AssistantDock {
  const wide = useMedia(LG);
  const [open, setOpen] = useState(readOpen);
  const [sheet, setSheet] = useState(false);
  const toggle = useCallback(() => setOpen(v => { writeOpen(!v); return !v; }), []);
  return { wide, open, sheet, toggle, setSheet };
}

/**
 * The header control. lg+: "Tampilkan asisten" while the column is hidden (the column's own top
 * bar holds "Sembunyikan asisten", so one control shows per state). Below lg: "Asisten" opens the sheet.
 */
export function AssistantToggle(props: { dock: AssistantDock }) {
  const { dock } = props;
  if (!dock.wide) {
    return <Button size="sm" variant="glass" onClick={() => dock.setSheet(true)} aria-haspopup="dialog"><MessageSquare /> Asisten</Button>;
  }
  if (dock.open) return null;
  return <IconTip label="Tampilkan asisten" onClick={dock.toggle}><PanelRight /></IconTip>;
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

type Shared = { dock: AssistantDock; story: Story; board: Board; onChanged: () => void };

/** lg+: the sticky column. Mounted once shown, then only hidden, so a reply keeps streaming. */
export function AssistantColumn(props: Shared) {
  const { dock } = props;
  const [shown, setShown] = useState(dock.open);
  if (dock.open && !shown) setShown(true);
  if (!dock.wide || !shown) return null;
  return (
    <aside hidden={!dock.open} aria-label="Kolom asisten"
      className="glass-panel sticky top-2 flex h-[calc(100svh-4rem)] w-[clamp(340px,26.5vw,420px)] shrink-0 flex-col overflow-hidden rounded-xl">
      <Suspense fallback={<PanelFallback />}>
        <AssistantPanel story={props.story} board={props.board} onChanged={props.onChanged} onClose={dock.toggle} closeLabel="Sembunyikan asisten" />
      </Suspense>
    </aside>
  );
}

/** Below lg: the same panel in a sheet from the right (full height, up to 420 px wide). */
export function AssistantSheet(props: Shared) {
  const { dock } = props;
  if (dock.wide) return null;
  return (
    <Sheet open={dock.sheet} onOpenChange={dock.setSheet}>
      <SheetContent side="right" showCloseButton={false} aria-label="Asisten proyek"
        className="w-[min(100vw,420px)] max-w-none gap-0 p-0 data-[side=right]:w-[min(100vw,420px)] data-[side=right]:sm:max-w-none">
        <Suspense fallback={<PanelFallback />}>
          <AssistantPanel story={props.story} board={props.board} onChanged={props.onChanged} onClose={() => dock.setSheet(false)} closeLabel="Tutup asisten" closeIcon="x" />
        </Suspense>
      </SheetContent>
    </Sheet>
  );
}

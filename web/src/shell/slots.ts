/**
 * Shell slots: places in the app shell (Layout) a page can render into with a portal.
 * - `TOPBAR_SLOT_ID`: the right end of the top bar (page-level controls such as "Tampilkan asisten").
 * - `RIGHT_PANEL_ID`: a full-height column beside `main`, level with the top bar (the project
 *   assistant). The page content shrinks to make room, like ChatGPT's side panel.
 * Without the shell (a page mounted alone in a test) the hook returns null and the page falls back
 * to rendering inline.
 */
import { useLayoutEffect, useState } from 'react';

export const TOPBAR_SLOT_ID = 'shell-topbar-slot';
export const RIGHT_PANEL_ID = 'shell-right-panel';

export function useShellSlot(id: string): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : document.getElementById(id)));
  useLayoutEffect(() => { setEl(document.getElementById(id)); }, [id]);
  return el;
}

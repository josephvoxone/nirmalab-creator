import { useCallback, useEffect, useState } from 'react';

/** Personal defaults, kept in this browser only (like ChatGPT's General tab). */
export type Prefs = { mode: 'konsisten' | 'cepat'; aspect: '9:16' | '16:9'; shots: '4' | '6' | '8' | '10' | '12'; density: 'ringkas' | 'nyaman' };
export const DEFAULT_PREFS: Prefs = { mode: 'konsisten', aspect: '9:16', shots: '8', density: 'ringkas' };
const KEY = 'nc.prefs';
const EVENT = 'nc-prefs';

export function readPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }; } catch { return DEFAULT_PREFS; }
}

export function applyDensity(p: Prefs = readPrefs()) {
  if (typeof document !== 'undefined') document.documentElement.dataset.density = p.density;
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(readPrefs);
  useEffect(() => {
    const sync = () => setPrefs(readPrefs());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const update = useCallback((patch: Partial<Prefs>) => {
    const next = { ...readPrefs(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: keep in memory */ }
    setPrefs(next);
    applyDensity(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [prefs, update];
}

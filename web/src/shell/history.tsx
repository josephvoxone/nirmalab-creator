import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { requestJson } from '../lib/api.js';
import { SessionContext } from '../lib/session.js';
import type { Story } from '../features/stories/storiesClient.js';

/** The sidebar's history, like a chat list: every page can ask it to refresh after creating a story. */
export type History = { stories?: Story[]; error?: unknown; reload: () => void };

const HistoryContext = createContext<History>({ reload: () => undefined });

export function HistoryProvider(props: { children: ReactNode; pollMs?: number }) {
  // No session yet (the shell renders while /api/auth/me is pending): stay in the loading state.
  const fetchImpl = useContext(SessionContext)?.fetchImpl;
  const [stories, setStories] = useState<Story[]>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!fetchImpl) return;
    let alive = true;
    requestJson<{ stories: Story[] }>(fetchImpl, '/api/stories').then(
      r => { if (alive) { setStories([...(Array.isArray(r?.stories) ? r.stories : [])].sort((a, b) => b.updatedAtMs - a.updatedAtMs)); setError(undefined); } },
      e => alive && setError(e)
    );
    return () => { alive = false; };
  }, [fetchImpl, tick]);

  useEffect(() => {
    const ms = props.pollMs ?? 20_000;
    if (!ms || !fetchImpl) return;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [props.pollMs, reload, fetchImpl]);

  const value = useMemo(() => ({ stories, error, reload }), [stories, error, reload]);
  return <HistoryContext.Provider value={value}>{props.children}</HistoryContext.Provider>;
}

export const useHistory = () => useContext(HistoryContext);

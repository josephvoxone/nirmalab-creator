/**
 * The workspace you are looking at (wave 4): the sidebar switches between the workspaces you
 * belong to, and pages read your role from here. Tolerant on purpose — a page mounted without
 * the provider (unit tests, a missing /api/workspaces) simply sees no workspace instead of
 * throwing, so the rest of the app keeps working.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SessionContext } from './session.js';
import { workspacesApi, type Role, type WorkspaceSummary } from './workspaces.js';

export type WorkspaceState = {
  workspaces: WorkspaceSummary[];
  current?: WorkspaceSummary;
  role?: Role;
  loading: boolean;
  error?: unknown;
  select: (id: string) => void;
  reload: () => void;
  /** My role in a given workspace (the project page passes the story's workspaceId). */
  roleFor: (workspaceId?: string) => Role | undefined;
};

const KEY = 'nc.workspace';
const IDLE: WorkspaceState = {
  workspaces: [], loading: false, select: () => undefined, reload: () => undefined, roleFor: () => undefined
};

const Ctx = createContext<WorkspaceState>(IDLE);

function stored(): string | undefined {
  try { return globalThis.localStorage?.getItem(KEY) ?? undefined; } catch { return undefined; }
}
function remember(id: string) {
  try { globalThis.localStorage?.setItem(KEY, id); } catch { /* private mode: keep it in memory */ }
}

export function WorkspaceProvider(props: { children: ReactNode }) {
  const fetchImpl = useContext(SessionContext)?.fetchImpl;
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [chosen, setChosen] = useState<string | undefined>(() => stored());
  const [loading, setLoading] = useState(!!fetchImpl);
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!fetchImpl) return;
    let alive = true;
    workspacesApi(fetchImpl).list().then(
      r => { if (!alive) return; setWorkspaces(r.workspaces); setError(undefined); },
      e => { if (alive) setError(e); }
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fetchImpl, tick]);

  const current = useMemo(
    () => workspaces.find(w => w.id === chosen) ?? workspaces.find(w => w.personal) ?? workspaces[0],
    [workspaces, chosen]
  );

  const select = useCallback((id: string) => { setChosen(id); remember(id); }, []);

  const value = useMemo<WorkspaceState>(() => ({
    workspaces,
    current,
    role: current?.role,
    loading,
    error,
    select,
    reload,
    roleFor: (workspaceId?: string) => workspaceId ? workspaces.find(w => w.id === workspaceId)?.role : current?.role
  }), [workspaces, current, loading, error, select, reload]);

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export const useWorkspaceState = () => useContext(Ctx);

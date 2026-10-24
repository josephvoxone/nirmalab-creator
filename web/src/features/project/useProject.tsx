/**
 * One project's state + every action on it, shared by all project tabs (Scene, Breakdown,
 * Timeline, Hasil). Edits are optimistic: the board changes at once, PUT runs behind, and a
 * refused save rolls back with the server's reason.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../lib/session.js';
import { describeError } from '../../ui/states.js';
import { ApiError } from '../../lib/api.js';
import { isActive, storiesApi, type Story, type Storyboard } from '../stories/storiesClient.js';
import { normalizeScenes, type Board } from './model.js';

export type RenderScope = { scene?: string; shot?: string };

export type Project = {
  id: string;
  story?: Story;
  board?: Board;
  /** First load failed (no data yet). */
  loadError?: unknown;
  /** Last action/save failure, plain Indonesian; cleared by the next action. */
  error?: string;
  /** A render refused for budget: offer "Render tetap". */
  budget?: { message: string; scope: RenderScope };
  /** Name of the running action ('save' | 'prepare' | 'render' | ...), for spinners. */
  busy?: string;
  /** Polling while the server is working; a failed poll keeps the data and sets this. */
  stale?: boolean;
  reload: () => void;
  /** Persist a new board (optimistic). */
  save: (next: Board) => Promise<boolean>;
  prepare: (scene?: string) => Promise<void>;
  render: (scope?: RenderScope, force?: boolean) => Promise<void>;
  assemble: () => Promise<void>;
  redraw: (shotId: string, prompt?: string) => Promise<void>;
  setLook: (look: Record<string, string>) => Promise<void>;
  retry: () => Promise<void>;
  /** Re-run the take with the audit's repair instruction (konsisten: free keyframe, cepat: a clip). */
  repair: (shotId: string) => Promise<void>;
  /** Human sign-off on a shot the audit refused. */
  approve: (shotId: string) => Promise<void>;
  dismiss: () => void;
};

export function useProjectState(id: string, pollMs = 4000): Project {
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const [story, setStory] = useState<Story>();
  const [board, setBoard] = useState<Board>();
  const [loadError, setLoadError] = useState<unknown>();
  const [error, setError] = useState<string>();
  const [budget, setBudget] = useState<Project['budget']>();
  const [busy, setBusy] = useState<string>();
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const saving = useRef(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let alive = true;
    api.get(id).then(r => {
      if (!alive) return;
      setStory(r.story);
      if (!saving.current) setBoard(normalizeScenes(r.storyboard as unknown as Board));
      setLoadError(undefined);
      setStale(false);
    }, e => { if (alive) { setLoadError(e); setStale(true); } });
    return () => { alive = false; };
  }, [api, id, tick]);

  const working = !!story && isActive(story);
  useEffect(() => {
    if (!working || !pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [working, pollMs, reload]);

  const run = useCallback(async (name: string, fn: () => Promise<{ story: Story }>) => {
    setBusy(name);
    setError(undefined);
    setBudget(undefined);
    try {
      const r = await fn();
      setStory(r.story);
      reload();
    } catch (e) {
      setError(describeError(e));
      throw e;
    } finally {
      setBusy(undefined);
    }
  }, [reload]);

  const save = useCallback(async (next: Board) => {
    const before = board;
    const normal = normalizeScenes(next);
    setBoard(normal);
    saving.current++;
    setBusy('save');
    setError(undefined);
    try {
      const r = await api.update(id, normal as unknown as Storyboard);
      setStory(r.story);
      return true;
    } catch (e) {
      setBoard(before);
      setError(`Perubahan tidak tersimpan: ${describeError(e)}`);
      return false;
    } finally {
      saving.current--;
      setBusy(undefined);
    }
  }, [api, board, id]);

  const render = useCallback(async (scope: RenderScope = {}, force = false) => {
    try {
      await run('render', () => api.render(id, force, scope));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BUDGET') { setError(undefined); setBudget({ message: e.message, scope }); }
    }
  }, [api, id, run]);

  const quiet = (p: Promise<void>) => p.catch(() => undefined);
  return {
    id, story, board, loadError, error, budget, busy, stale, reload, save, render,
    prepare: scene => quiet(run('prepare', () => api.prepare(id, scene))),
    assemble: () => quiet(run('assemble', () => api.assemble(id))),
    redraw: (shotId, prompt) => quiet(run(`redraw:${shotId}`, () => api.redraw(id, shotId, prompt))),
    setLook: look => quiet(run('look', () => api.setLook(id, look)).then(reload)),
    retry: () => quiet(run('retry', () => api.retry(id))),
    repair: shotId => quiet(run(`repair:${shotId}`, () => api.repairShot(id, shotId))),
    approve: shotId => quiet(run(`approve:${shotId}`, () => api.approveShot(id, shotId))),
    dismiss: () => { setError(undefined); setBudget(undefined); }
  };
}

const ProjectContext = createContext<Project | null>(null);
export const ProjectProvider = ProjectContext.Provider;

export function useProject(): Project {
  const p = useContext(ProjectContext);
  if (!p) throw new Error('useProject outside ProjectProvider');
  return p;
}

/** Media URLs for a project (cache-busted by the take that produced them). */
export const media = {
  frame: (id: string, shotId: string, v = '') => `/api/stories/${id}/shots/${shotId}/frame${v ? `?v=${v}` : ''}`,
  clip: (id: string, shotId: string, v = '') => `/api/stories/${id}/shots/${shotId}/video${v ? `?v=${v}` : ''}`,
  cast: (id: string, token: string, v = '') => `/api/stories/${id}/cast/${token}/image${v ? `?v=${v}` : ''}`,
  final: (id: string, v = '') => `/api/stories/${id}/video${v ? `?v=${v}` : ''}`
};

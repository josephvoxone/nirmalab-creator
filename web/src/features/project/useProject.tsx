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

export const STALE_NOTICE = 'Proyek baru diubah asisten — dimuat ulang';
export const STALE_NOTICE_MS = 6000;

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
  /** One short-lived notice (e.g. the board was reloaded after someone else changed it); clears itself after 6 s. */
  notice?: string;
  /** Refetch story + board now (the chat panel calls it after every assistant turn). Never replaces a board mid-save. */
  reload: () => void;
  /**
   * Persist a new board (optimistic) with the `rev` it was read at. A 409 STALE (the assistant or
   * another tab saved first) refetches, shows `notice` and resolves false: editors keep their
   * local values so the user can save again on top of the fresh board.
   */
  save: (next: Board) => Promise<boolean>;
  /** Take a server answer that carries the whole new state (scene breakdown). */
  apply: (r: { story: Story; storyboard?: Storyboard }) => void;
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
  const [notice, setNotice] = useState<string>();
  const [tick, setTick] = useState(0);
  const saving = useRef(0);
  /** Newest revision seen from the server (revisions only grow: restore and undo bump them too). */
  const rev = useRef<number>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const reload = useCallback(() => setTick(t => t + 1), []);
  const take = useCallback((s: Story) => {
    if (typeof s.rev === 'number') rev.current = Math.max(rev.current ?? 0, s.rev);
    setStory(s);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), STALE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    let alive = true;
    api.get(id).then(r => {
      if (!alive) return;
      take(r.story);
      if (!saving.current) setBoard(normalizeScenes(r.storyboard as unknown as Board));
      setLoadError(undefined);
      setStale(false);
    }, e => { if (alive) { setLoadError(e); setStale(true); } });
    return () => { alive = false; };
  }, [api, id, tick, take]);

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
      take(r.story);
      reload();
    } catch (e) {
      setError(describeError(e));
      throw e;
    } finally {
      setBusy(undefined);
    }
  }, [reload, take]);

  const save = useCallback(async (next: Board) => {
    const before = board;
    const normal = normalizeScenes(next);
    setBoard(normal);
    saving.current++;
    setBusy('save');
    setError(undefined);
    // Saves go out one at a time, each with the rev the previous one returned (two quick edits
    // must not refuse each other as STALE).
    const previous = queue.current;
    let finished!: () => void;
    queue.current = new Promise<void>(resolve => { finished = resolve; });
    try {
      await previous;
      const r = await api.update(id, normal as unknown as Storyboard, rev.current);
      take(r.story);
      // Bible boards are rewritten on save (prompts rebuilt from intent, the other side of each
      // fact mirrored): read the board back so the next edit starts from what was stored.
      if (normal.bible) reload();
      return true;
    } catch (e) {
      setBoard(before);
      if (e instanceof ApiError && e.status === 409 && e.code === 'STALE') {
        setNotice(STALE_NOTICE);
        reload();
      } else {
        setError(`Perubahan tidak tersimpan: ${describeError(e)}`);
      }
      return false;
    } finally {
      finished();
      saving.current--;
      setBusy(undefined);
    }
  }, [api, board, id, reload, take]);

  const apply = useCallback((r: { story: Story; storyboard?: Storyboard }) => {
    take(r.story);
    if (r.storyboard && !saving.current) setBoard(normalizeScenes(r.storyboard as unknown as Board));
    reload();
  }, [reload, take]);

  const render = useCallback(async (scope: RenderScope = {}, force = false) => {
    try {
      await run('render', () => api.render(id, force, scope));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BUDGET') { setError(undefined); setBudget({ message: e.message, scope }); }
    }
  }, [api, id, run]);

  const quiet = (p: Promise<void>) => p.catch(() => undefined);
  return {
    id, story, board, loadError, error, budget, busy, stale, notice, reload, save, apply, render,
    prepare: scene => quiet(run('prepare', () => api.prepare(id, scene))),
    assemble: () => quiet(run('assemble', () => api.assemble(id))),
    redraw: (shotId, prompt) => quiet(run(`redraw:${shotId}`, () => api.redraw(id, shotId, prompt))),
    setLook: look => quiet(run('look', () => api.setLook(id, look)).then(reload)),
    retry: () => quiet(run('retry', () => api.retry(id))),
    repair: shotId => quiet(run(`repair:${shotId}`, () => api.repairShot(id, shotId))),
    approve: shotId => quiet(run(`approve:${shotId}`, () => api.approveShot(id, shotId))),
    dismiss: () => { setError(undefined); setBudget(undefined); setNotice(undefined); }
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

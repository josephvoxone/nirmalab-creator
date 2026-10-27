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

export const STALE_NOTICE = 'Proyek baru diubah di tempat lain — dimuat ulang';
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
  /** Revision of `board` (the server's `rev` when this board was read or last saved). */
  rev?: number;
  /**
   * Persist a new board (optimistic). Every PUT carries the rev of the board the edit was built from:
   * - `save(board)` — built from the board of the same render (that render's `rev`), or pass `baseRev`;
   * - `save(latest => board)` — run on the newest board when the save's turn comes (use it after an await).
   * A 409 STALE (the assistant or another tab saved first) refetches, shows `notice` and resolves false:
   * editors keep their local values so the user can save again on top of the fresh board.
   */
  save: (next: Board | ((latest: Board) => Board), baseRev?: number) => Promise<boolean>;
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

/** A board and the revision it belongs to: the two always travel together. */
type Snap = { board: Board; rev?: number };
/** The last save that went out: the base it was built from, and how it ended. */
type Sent = { base?: number; ok: boolean; rev?: number; stale?: boolean };

export function useProjectState(id: string, pollMs = 4000): Project {
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const [story, setStory] = useState<Story>();
  const [snap, setSnap] = useState<Snap>();
  const [loadError, setLoadError] = useState<unknown>();
  const [error, setError] = useState<string>();
  const [budget, setBudget] = useState<Project['budget']>();
  const [busy, setBusy] = useState<string>();
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [tick, setTick] = useState(0);
  const saving = useRef(0);
  /** The board on screen (optimistic edits included) with the rev it was built from. */
  const latest = useRef<Snap>(undefined);
  /** The last board the server confirmed (GET, apply, a good save): where a refused save rolls back to. */
  const confirmed = useRef<Snap>(undefined);
  const last = useRef<Sent>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const show = useCallback((next: Snap, sure = false) => {
    latest.current = next;
    if (sure) confirmed.current = next;
    setSnap(next);
  }, []);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), STALE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    let alive = true;
    api.get(id).then(r => {
      if (!alive) return;
      setStory(r.story);
      // Never mid-save: the board and its rev are replaced together, or not at all.
      if (!saving.current) show({ board: normalizeScenes(r.storyboard as unknown as Board), rev: r.story.rev }, true);
      setLoadError(undefined);
      setStale(false);
    }, e => { if (alive) { setLoadError(e); setStale(true); } });
    return () => { alive = false; };
  }, [api, id, tick, show]);

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

  const renderedRev = snap?.rev;
  const save = useCallback(async (next: Board | ((latest: Board) => Board), baseRev?: number) => {
    const updater = typeof next === 'function';
    // A board built from this render's board carries this render's rev (a stale closure keeps its old rev).
    let base = updater ? undefined : baseRev ?? renderedRev;
    let normal = updater ? undefined : normalizeScenes(next);
    if (normal) show({ board: normal, rev: base });
    saving.current++;
    setBusy('save');
    setError(undefined);
    const previous = queue.current;
    let finished!: () => void;
    queue.current = new Promise<void>(resolve => { finished = resolve; });
    const refused = (staleSave: boolean, message?: string) => {
      if (confirmed.current) show(confirmed.current);
      if (staleSave) { setNotice(STALE_NOTICE); reload(); } else if (message) setError(`Perubahan tidak tersimpan: ${message}`);
    };
    try {
      await previous;
      if (updater) {
        const now = latest.current;
        if (!now) return false;
        base = now.rev;
        normal = normalizeScenes((next as (b: Board) => Board)(now.board));
        show({ board: normal, rev: base });
      }
      // Saves go out one at a time. One built from the same base as the save before it continues
      // from what that save returned (two quick edits must not refuse each other); if that save was
      // refused, this one was built on a refused board and is refused too, without a request.
      let rev = base;
      const before = last.current;
      if (before && before.base === base && base !== undefined) {
        if (!before.ok) {
          last.current = { base, ok: false, stale: true };
          refused(true);
          return false;
        }
        rev = before.rev;
      }
      try {
        const r = await api.update(id, normal! as unknown as Storyboard, rev);
        last.current = { base, ok: true, rev: r.story.rev };
        setStory(r.story);
        const saved = { board: normal!, rev: r.story.rev };
        confirmed.current = saved;
        // The board on screen moves to the new rev only when no later save is still built on the old one.
        if (saving.current === 1) show(saved);
        // Bible boards are rewritten on save (prompts rebuilt from intent, the other side of each
        // fact mirrored): read the board back so the next edit starts from what was stored.
        if (normal!.bible) reload();
        return true;
      } catch (e) {
        const staleSave = e instanceof ApiError && e.status === 409 && e.code === 'STALE';
        last.current = { base, ok: false, stale: staleSave };
        refused(staleSave, describeError(e));
        return false;
      }
    } finally {
      finished();
      saving.current--;
      if (!saving.current) {
        setBusy(undefined);
        last.current = undefined;
      }
    }
  }, [api, id, reload, renderedRev, show]);

  const apply = useCallback((r: { story: Story; storyboard?: Storyboard }) => {
    setStory(r.story);
    if (r.storyboard && !saving.current) show({ board: normalizeScenes(r.storyboard as unknown as Board), rev: r.story.rev }, true);
    reload();
  }, [reload, show]);

  const render = useCallback(async (scope: RenderScope = {}, force = false) => {
    try {
      await run('render', () => api.render(id, force, scope));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BUDGET') { setError(undefined); setBudget({ message: e.message, scope }); }
    }
  }, [api, id, run]);

  const quiet = (p: Promise<void>) => p.catch(() => undefined);
  return {
    id, story, board: snap?.board, rev: snap?.rev, loadError, error, budget, busy, stale, notice, reload, save, apply, render,
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

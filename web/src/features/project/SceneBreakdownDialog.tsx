/**
 * "Pecah jadi shot (AI)" for one scene of a bible board: the AI writes N shot intents from the
 * bible (scene goal, location, anchors), the server compiles and inserts them. Only offered on
 * bible boards; the server refuses legacy ones anyway.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RotateCcw, Sparkles } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Segmented } from '../../ui/controls.js';
import { MentionTextarea } from '../../ui/MentionTextarea.js';
import { describeError } from '../../ui/states.js';
import { storiesApi, type BreakdownMode, type ShotState } from '../stories/storiesClient.js';
import { mentionTriggers } from './mentions.js';
import type { Board, Scene, Shot } from './model.js';
import { useProject } from './useProject.js';

const COUNTS = ['2', '3', '4', '5', '6', '7', '8'] as const;
const PLACEHOLDER_PROMPT = 'Medium shot, the camera stays still.';

/**
 * A shot with nothing in it yet: a placeholder prompt, or an intent without action and states.
 * A shot that already has a done clip or a done keyframe is never empty (replacing it would throw a take away).
 */
export function isEmptyShot(s: Shot, state?: ShotState): boolean {
  if (s.reuse) return false;
  if (state?.status === 'done' || state?.frame?.status === 'done') return false;
  if (s.intent) return !s.intent.action?.trim() && !s.intent.startState?.trim() && !s.intent.endState?.trim();
  const prose = (s.prompt ?? '').trim();
  return !prose || prose === PLACEHOLDER_PROMPT;
}

/** `noModel`: set up a text model; `needsBible`: the bible is missing a goal (or the board has none) — a retry cannot fix either. */
type Failure = { message: string; noModel?: boolean; needsBible?: boolean };

function failureOf(e: unknown): Failure {
  if (e instanceof ApiError && e.code === 'NOT_CONFIGURED') return { message: 'Butuh model teks — atur di Pengaturan › Provider', noModel: true };
  if (e instanceof ApiError && e.code === 'INVALID') {
    if (/belum punya tujuan/i.test(e.message)) return { message: 'Scene ini belum punya tujuan — isi dulu di tab Bible.', needsBible: true };
    if (/butuh bible|tab bible/i.test(e.message)) return { message: describeError(e), needsBible: true };
  }
  return { message: describeError(e) };
}

export function SceneBreakdownDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; board: Board; scene: Scene }) {
  const p = useProject();
  const { fetchImpl } = useSession();
  const location = useLocation();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const { board, scene } = props;
  const onlyEmpty = scene.shots.every(id => { const s = board.shots.find(x => x.id === id); return !s || isEmptyShot(s, p.story?.shots.find(x => x.id === id)); });
  const [count, setCount] = useState<(typeof COUNTS)[number]>('4');
  const [brief, setBrief] = useState('');
  const [mode, setMode] = useState<BreakdownMode>(onlyEmpty ? 'replace' : 'append');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const triggers = useMemo(() => mentionTriggers(p.id, board, p.story), [p.id, board, p.story]);
  const effectiveMode: BreakdownMode = onlyEmpty ? mode : 'append';
  // Each opening starts from the scene as it is now (it may have been emptied or filled since).
  useEffect(() => { if (props.open) setMode(onlyEmpty ? 'replace' : 'append'); }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setRunning(true);
    setFailure(undefined);
    try {
      const r = await api.breakdown(p.id, scene.id, { count: Number(count), ...(brief.trim() ? { brief: brief.trim() } : {}), mode: effectiveMode });
      p.apply(r);
      props.onOpenChange(false);
      setBrief('');
    } catch (e) {
      setFailure(failureOf(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    // Closing while the AI works is fine: the result still lands on the board, an error waits here.
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pecah “{scene.title}” jadi shot</DialogTitle>
          <DialogDescription>AI menyusun niat tiap shot dari bible — tujuan scene, lokasi dan anchor karakter. Prompt disusun otomatis dan bisa diubah per shot.</DialogDescription>
        </DialogHeader>
        {running ? (
          <div role="status" aria-label="AI sedang memecah scene…" className="flex flex-col gap-1.5">
            <p className="text-[12.5px] text-muted-foreground">AI sedang memecah scene…</p>
            {Array.from({ length: Number(count) }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Jumlah shot</span>
              <Segmented name="Jumlah shot" value={count} options={COUNTS.map(c => ({ value: c, label: c }))} onChange={setCount} className="w-fit" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Arahan <span className="text-muted-foreground/70">(opsional)</span></span>
              <MentionTextarea ariaLabel="Arahan" rows={2} maxRows={5} value={brief} onChange={setBrief} triggers={triggers}
                placeholder="mis. buka dengan close-up tangan @LARAS, akhiri di pintu" className="text-[12.5px]" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Mode</span>
              <Segmented name="Mode" value={effectiveMode} onChange={setMode} className="w-fit"
                options={[{ value: 'replace', label: 'Ganti shot kosong', disabled: !onlyEmpty }, { value: 'append', label: 'Tambah di akhir' }]} />
              {!onlyEmpty && <span className="text-[11.5px] text-muted-foreground">Scene ini sudah punya shot berisi — shot baru ditambahkan di akhir.</span>}
            </div>
            {failure && (
              <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-[12.5px] text-destructive">
                <span>{failure.message}</span>
                <div className="flex gap-1.5">
                  {failure.noModel
                    ? <Link to="/pengaturan/provider" state={{ background: (location.state as { background?: unknown } | null)?.background ?? location }} className={buttonVariants({ size: 'xs', variant: 'glass' })}>Buka Pengaturan › Provider</Link>
                    : failure.needsBible
                      ? <Link to="?tab=bible" replace onClick={() => props.onOpenChange(false)} className={buttonVariants({ size: 'xs', variant: 'glass' })}>Buka tab Bible</Link>
                      : <Button type="button" size="xs" variant="ghost" onClick={() => void run()}><RotateCcw /> Coba lagi</Button>}
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>Batal</Button>
          <Button type="button" size="sm" disabled={running || !!p.busy} onClick={() => void run()}><Sparkles /> Pecah jadi {count} shot</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

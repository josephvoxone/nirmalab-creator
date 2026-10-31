import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clapperboard, LayoutGrid, Play, RefreshCw, Search, SquarePen, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { poster, sizedImg } from '../../lib/media.js';
import { useHistory } from '../../shell/history.js';
import { describeError } from '../../ui/states.js';
import { relativeTime } from '../settings/settingsClient.js';
import { STATUS_LABEL, doneCount, isActive, storiesApi, type Story } from './storiesClient.js';

const FILTERS: Array<{ id: string; label: string; test: (s: Story) => boolean }> = [
  { id: 'semua', label: 'Semua', test: () => true },
  { id: 'berjalan', label: 'Berjalan', test: isActive },
  { id: 'review', label: 'Siap direview', test: s => s.status === 'review' },
  { id: 'draft', label: 'Draft', test: s => s.status === 'draft' },
  { id: 'selesai', label: 'Selesai', test: s => s.status === 'done' },
  { id: 'gagal', label: 'Gagal', test: s => s.status === 'failed' }
];

const tone = (s: Story) => s.status === 'done' ? 'text-(--success)' : s.status === 'failed' ? 'text-destructive' : s.status === 'review' ? 'text-(--brand)' : isActive(s) ? 'text-foreground' : 'text-muted-foreground';

const finished = (s: Story) => s.status === 'done' || !!s.video;
const finalUrl = (s: Story) => `/api/stories/${s.id}/video${s.video ? `?v=${s.video.finishedAtMs}` : ''}`;
const CARD_W = 240;

/** A real picture of the project: the final video's poster, else its first keyframe, else a neutral tile. */
function Thumb(props: { src?: string; srcSet?: string; onBroken: () => void; broken: boolean }) {
  return (
    <span className="relative block aspect-[4/5] w-full overflow-hidden bg-muted">
      {!props.broken && props.src && (
        <img src={props.src} srcSet={props.srcSet} width={CARD_W} height={300} alt="" loading="lazy" decoding="async" onError={props.onBroken} className="absolute inset-0 size-full object-cover" />
      )}
      {(props.broken || !props.src) && <Clapperboard aria-hidden="true" className="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/50" />}
    </span>
  );
}

/** Card picture: a link into the project, or — when the final video exists — a click-to-play preview. */
function CardMedia(props: { story: Story }) {
  const s = props.story;
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  if (finished(s)) {
    const v = s.video ? String(s.video.finishedAtMs) : undefined;
    const still = sizedImg(poster.final(s.id, CARD_W, v), CARD_W);
    if (playing) {
      return (
        <span className="relative block aspect-[4/5] w-full overflow-hidden bg-black">
          <video src={finalUrl(s)} poster={poster.final(s.id, CARD_W * 2, v)} autoPlay controls playsInline aria-label={`Preview ${s.title}`}
            onError={() => { setPlaying(false); setBroken(true); }} className="absolute inset-0 size-full object-contain" />
        </span>
      );
    }
    return (
      <button type="button" aria-label={`Putar preview ${s.title}`} title="Putar video di sini" onClick={() => setPlaying(true)}
        className="group/play relative block w-full outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
        <Thumb src={still.src} srcSet={still.srcSet} broken={broken} onBroken={() => setBroken(true)} />
        <span aria-hidden="true" className="absolute top-1/2 left-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover/play:bg-black/70 [&_svg]:size-4 [&_svg]:fill-current">
          <Play className="ml-0.5" />
        </span>
      </button>
    );
  }
  const frame = s.shots.find(x => x.frame?.status === 'done');
  const still = frame ? sizedImg(`/api/stories/${s.id}/shots/${frame.id}/frame${frame.frame?.mediaId ? `?v=${frame.frame.mediaId}` : ''}`, CARD_W) : undefined;
  return (
    <Link to={`/cerita/${s.id}`} aria-label={`Buka ${s.title}`} className="outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
      <Thumb src={still?.src} srcSet={still?.srcSet} broken={broken} onBroken={() => setBroken(true)} />
    </Link>
  );
}

export function StoriesPage(props: { pollMs?: number }) {
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const history = useHistory();
  const navigate = useNavigate();
  const [stories, setStories] = useState<Story[]>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState('semua');
  const [q, setQ] = useState('');
  const [doomed, setDoomed] = useState<Story>();
  const [deleteError, setDeleteError] = useState('');
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let alive = true;
    api.list().then(r => { if (alive) { setStories([...(Array.isArray(r?.stories) ? r.stories : [])].sort((a, b) => b.updatedAtMs - a.updatedAtMs)); setError(undefined); } }, e => alive && setError(e));
    return () => { alive = false; };
  }, [api, tick]);
  const running = stories?.some(isActive);
  useEffect(() => {
    const ms = props.pollMs ?? 8000;
    if (!ms || !running) return;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [props.pollMs, running, reload]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, (stories ?? []).filter(f.test).length])), [stories]);
  const shown = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter) ?? FILTERS[0]!;
    const needle = q.trim().toLowerCase();
    return (stories ?? []).filter(s => f.test(s) && (!needle || s.title.toLowerCase().includes(needle)));
  }, [stories, filter, q]);

  const remove = async (s: Story) => {
    setDeleteError('');
    try {
      await api.remove(s.id);
      setStories(list => list?.filter(x => x.id !== s.id));
      history.reload();
    } catch (e) { setDeleteError(`Gagal menghapus "${s.title}": ${describeError(e)}`); }
    setDoomed(undefined);
  };

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <div className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center">
        <p className="text-[13px] text-muted-foreground">
          Semua video yang sedang atau sudah kamu buat. <span className="text-foreground/70">Template adalah resep awal untuk memulai;</span> proyek adalah hasil kerjamu.
        </p>
        <div className="flex items-center gap-2 sm:ml-auto">
          <label className="flex h-8 items-center gap-2 rounded-md border bg-(--field) px-2.5 sm:w-56 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
            <Search aria-hidden="true" />
            <input type="search" aria-label="Cari proyek" placeholder="Cari proyek…" value={q} onChange={e => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
          </label>
          <Button size="sm" onClick={() => navigate('/')}><SquarePen /> Buat baru</Button>
        </div>
      </div>

      {stories && stories.length > 0 && (
        <div role="tablist" aria-label="Status" className="mb-3 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
          {FILTERS.map(f => (
            <button key={f.id} role="tab" type="button" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
              className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60',
                filter === f.id && 'glass-chosen text-foreground')}>
              {f.label} <span className="text-[11px] text-muted-foreground">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      )}
      {deleteError && <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{deleteError}</p>}

      {error && !stories ? (
        <div role="alert" className="glass-panel mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-lg px-6 py-8 text-center">
          <b className="text-sm font-medium">Gagal memuat proyek</b>
          <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>
          <Button variant="glass" size="sm" onClick={reload}><RefreshCw /> Coba lagi</Button>
        </div>
      ) : !stories ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-busy="true" aria-label="Memuat proyek">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] rounded-lg" />)}
        </div>
      ) : stories.length === 0 ? (
        <div className="glass-panel mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-lg px-6 py-8 text-center">
          <h2 className="text-sm font-medium">Belum ada proyek</h2>
          <p className="text-[13px] text-muted-foreground">Tulis premis di Buat baru, atau mulai dari template yang gaya dan kameranya sudah diatur.</p>
          <div className="mt-1 flex gap-2">
            <Button size="sm" onClick={() => navigate('/')}><SquarePen /> Buat baru</Button>
            <Button size="sm" variant="glass" onClick={() => navigate('/template')}><LayoutGrid /> Lihat template</Button>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="mt-8 text-center text-[13px] text-muted-foreground">Tidak ada proyek yang cocok dengan filter ini.</p>
      ) : (
        <ul aria-label="Daftar proyek" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map(s => (
            <li key={s.id} aria-label={s.title} className="group glass-panel relative flex flex-col overflow-hidden rounded-lg">
              <CardMedia story={s} />
              <div className="flex flex-col gap-1 p-2.5">
                <Link to={`/cerita/${s.id}`} tabIndex={finished(s) ? undefined : -1} className="truncate rounded-sm text-[13px] font-medium outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/60">{s.title}</Link>
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Badge variant="secondary" className={cn('h-4.5 px-1.5 text-[10.5px]', tone(s))}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
                  <span className="tabular-nums">{doneCount(s)}/{s.shots.length} shot</span>
                  <span className="ml-auto truncate">{relativeTime(s.updatedAtMs)}</span>
                </div>
              </div>
              <Button size="icon-sm" variant="glass" aria-label={`Hapus ${s.title}`} onClick={() => setDoomed(s)}
                className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={!!doomed} onOpenChange={o => { if (!o) setDoomed(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus "{doomed?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>Storyboard, keyframe dan video proyek ini dihapus dari server. Tidak bisa dibatalkan.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => doomed && void remove(doomed)}>Hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

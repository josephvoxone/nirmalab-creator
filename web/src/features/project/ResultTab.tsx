/**
 * Hasil tab: the assembled video (small, fullscreen on demand) with download / re-assemble /
 * publish, or — before there is one — where the project stands and the one next step. Every
 * scene can be previewed on its own in a small dialog.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clapperboard, Download, Film, Images, Play, RefreshCw, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { isActive, STATUS_LABEL } from '../stories/storiesClient.js';
import { sceneProgress, type Board } from './model.js';
import { nextStep } from './nextStep.js';
import { media, useProject, type Project } from './useProject.js';
import { ClipPreview, SequencePlayer } from './Player.js';
import { formatSeconds, sequenceClips } from './TimelineModel.js';

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
const when = (ms: number) => new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Names the project's next step; the header button runs it (never a second copy here). */
function NextAction(props: { p: Project }) {
  const { story, board } = props.p;
  if (!story || !board) return null;
  const step = nextStep(story, board);
  if (step.kind === 'working') return <p role="status" className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><RefreshCw className="size-3.5 animate-spin" /> Sedang {step.label.toLowerCase()}…</p>;
  if (step.kind === 'none' || step.kind === 'publish') return null;
  return <p className="text-[12px] text-muted-foreground">Langkah berikutnya: <span className="text-foreground">{step.label}</span> — tombol di kanan atas.</p>;
}

function ScenePreviews(props: { p: Project; board: Board }) {
  const { id, story } = props.p;
  const [open, setOpen] = useState<string>();
  const scenes = props.board.scenes ?? [];
  const playing = scenes.find(s => s.id === open);
  const clips = useMemo(() => (story && playing ? sequenceClips(id, props.board, story, playing.shots) : []), [id, props.board, story, playing]);
  if (!story) return null;
  return (
    <>
      <ul aria-label="Scene" className="flex flex-col">
        {scenes.map((s, i) => {
          const pr = sceneProgress(story, props.board, s.id);
          const done = pr.shots > 0 && pr.clips === pr.shots;
          const state = !pr.shots ? 'Kosong' : done ? 'Selesai' : pr.queued ? 'Sedang dirender' : 'Belum lengkap';
          return (
            <li key={s.id} className="flex items-center gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-b-0">
              <span className="w-5 shrink-0 text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="text-[11.5px] text-muted-foreground tabular-nums">{pr.clips}/{pr.shots} klip · {formatSeconds(pr.seconds)}</span>
              {pr.failed > 0 && <span className="text-[11.5px] text-destructive">{pr.failed} gagal</span>}
              <span className={cn('w-24 text-right text-[11.5px]', done ? 'text-(--success)' : 'text-muted-foreground')}>{state}</span>
              <Button size="xs" variant="ghost" disabled={!pr.shots} aria-label={`Putar scene ${s.title}`} onClick={() => setOpen(s.id)}><Play /> Putar scene</Button>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!playing} onOpenChange={o => { if (!o) setOpen(undefined); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{playing?.title}</DialogTitle>
            <DialogDescription>Preview scene: klip yang belum dirender tampil sebagai keyframe.</DialogDescription>
          </DialogHeader>
          {playing && <SequencePlayer clips={clips} label={`Preview scene ${playing.title}`} maxH={300} aspect={props.board.aspect} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ResultTab() {
  const p = useProject();
  const { id, story, board, busy } = p;
  if (!story || !board) return null;
  if (!board.shots.length) {
    return (
      <Empty className="glass-panel rounded-lg py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Film /></EmptyMedia>
          <EmptyTitle>Belum ada shot</EmptyTitle>
          <EmptyDescription>Tulis naskah dan tambah shot di tab Scene dulu; video akhir dirakit dari semua shot.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const total = story.shots.length;
  const done = story.shots.filter(s => s.status === 'done').length;
  const allDone = total > 0 && done === total;
  const assembling = busy === 'assemble' || story.status === 'assembling';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {story.video ? (
        <div className="glass-panel flex flex-wrap items-start gap-4 rounded-lg p-3">
          <ClipPreview src={media.final(id, String(story.video.finishedAtMs))} label="Video akhir" maxH={320} />
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-muted-foreground">Ukuran</dt><dd className="tabular-nums">{megabytes(story.video.bytes)}</dd>
              <dt className="text-muted-foreground">Selesai</dt><dd className="tabular-nums">{when(story.video.finishedAtMs)}</dd>
              <dt className="text-muted-foreground">Isi</dt><dd>{board.scenes?.length ?? 1} scene · {total} shot · {board.aspect ?? '9:16'}</dd>
            </dl>
            {story.videoStale && <p className="text-[12px] text-muted-foreground">Video ini belum mengikuti urutan terbaru di timeline.</p>}
            <div className="flex flex-wrap gap-1.5">
              <a href={media.final(id)} download className={buttonVariants({ size: 'sm', variant: 'glass' })}><Download /> Unduh</a>
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel flex flex-col gap-2.5 rounded-lg p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-md bg-muted"><Film className="size-4 text-muted-foreground" /></span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium">Video akhir belum dirakit</span>
              <span className="text-[12px] text-muted-foreground">
                {allDone ? 'Semua klip selesai — tinggal dirakit jadi satu video.' : 'Video dirakit otomatis setelah semua klip selesai dirender.'}
              </span>
            </div>
            <NextAction p={p} />
          </div>
          <div className="flex items-center gap-2">
            <Progress value={total ? Math.round((done / total) * 100) : 0} aria-label="Klip selesai" className="flex-1" />
            <span className="text-[12px] text-muted-foreground tabular-nums">{done}/{total} klip selesai</span>
          </div>
        </div>
      )}

      <div className="glass-panel flex flex-col gap-1 rounded-lg px-3 py-2">
        <span className="text-[12px] font-medium text-muted-foreground">Preview per scene</span>
        <ScenePreviews p={p} board={board} />
      </div>
    </div>
  );
}

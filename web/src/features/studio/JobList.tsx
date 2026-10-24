import { Clapperboard, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sized } from '../../lib/media.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { FlowJob } from './flowClient.js';

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Antre',
  running: 'Diproses',
  done: 'Selesai',
  failed: 'Gagal'
};

const STATUS_CLASS: Record<string, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-destructive/15 text-destructive'
};

export function relative(ms?: number): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

/** Step 4: what the bridge did with your jobs. */
export function JobList(props: {
  jobs: FlowJob[];
  loaded: boolean;
  loadFailed: boolean;
  busy: boolean;
  fileUrl: (jobId: string) => string;
  accountLabel: (id?: string) => string;
  onRetry: (job: FlowJob) => void;
  onStart: () => void;
}) {
  if (!props.loaded) {
    if (props.loadFailed) return <p className="py-6 text-center text-[13px] text-muted-foreground">Antrean belum bisa ditampilkan. Lihat pesan di atas lalu tekan Coba lagi.</p>;
    return (
      <div role="status" aria-busy="true" aria-label="Memuat antrean" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-56 rounded-lg" />)}
      </div>
    );
  }
  if (props.jobs.length === 0) {
    return (
      <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-2 text-center">
        <Clapperboard aria-hidden="true" className="size-6 text-muted-foreground" />
        <b className="text-sm font-medium">Belum ada hasil</b>
        <p className="text-[13px] text-muted-foreground">Klip dan gambar yang kamu antrekan muncul di sini. Bridge di Mac mengambilnya satu per satu dari akun Flow.</p>
        <Button variant="glass" size="sm" onClick={props.onStart}>Buat yang pertama</Button>
      </div>
    );
  }
  return (
    <ul aria-label="Antrean" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {props.jobs.map(job => (
        <li key={job.id} aria-label={job.prompt} className="glass-panel flex flex-col overflow-hidden rounded-lg">
          {job.status === 'done' && job.kind === 'image' ? (
            <img src={sized(props.fileUrl(job.id), 360)} alt={job.prompt} loading="lazy" decoding="async" className={cn('w-full bg-muted object-cover', job.aspect === '9:16' ? 'aspect-[9/16] max-h-80' : 'aspect-video')} />
          ) : job.status === 'done' ? (
            <video data-testid={`clip-${job.id}`} src={props.fileUrl(job.id)} controls preload="metadata"
              className={cn('w-full bg-black object-contain', job.aspect === '9:16' ? 'aspect-[9/16] max-h-80' : 'aspect-video')} />
          ) : (
            <div className="flex aspect-video items-center justify-center bg-muted/60 text-[12px] text-muted-foreground">
              {job.status === 'failed' ? 'Tidak ada hasil' : job.status === 'running' ? 'Sedang dirender di Flow…' : 'Menunggu bridge…'}
            </div>
          )}
          <div className="flex flex-1 flex-col gap-1.5 p-2.5">
            <div className="flex items-center gap-1.5">
              <Badge className={cn('h-4.5 px-1.5 text-[10.5px]', STATUS_CLASS[job.status] ?? 'bg-muted text-muted-foreground')}>{STATUS_LABEL[job.status] ?? job.status}</Badge>
              <span className="text-[11.5px] text-muted-foreground">{job.aspect}{job.kind === 'image' ? ' · gambar' : ` · ${job.durationSec}s`}</span>
              <span className="ml-auto text-[11.5px] text-muted-foreground">{relative(job.finishedAtMs ?? job.createdAtMs)}</span>
            </div>
            <p title={job.prompt} className="line-clamp-2 text-[12.5px] leading-snug">{job.prompt}</p>
            <span className="text-[11.5px] text-muted-foreground">{props.accountLabel(job.accountId)}</span>
            {job.status === 'failed' && (
              <div className="mt-auto flex items-center gap-2 pt-1">
                <p className="min-w-0 flex-1 text-[12px] text-destructive">{job.error || 'Render gagal tanpa keterangan dari Flow.'}</p>
                <Button size="sm" variant="glass" disabled={props.busy} onClick={() => props.onRetry(job)}><RotateCcw /> Coba lagi</Button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

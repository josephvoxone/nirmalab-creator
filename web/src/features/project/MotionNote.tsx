/**
 * "Cek gerak klip" in the shot sheet: what the free motion check found in THIS clip, in plain words, and the free
 * fixes (trim / zoom in the Timeline). Read-only on purpose: nothing here can start a render or cost credits.
 * States: waiting (clip in flight), empty (not checked), error (could not run), ok, warn, fail.
 */
import { CircleCheck, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShotState, Story } from '../stories/storiesClient.js';
import { MOTION_LIMIT, motionSuggestions, motionView } from './motion.js';

export function MotionNote(props: { shot?: ShotState; events: Story['events'] }) {
  const { state, motion } = motionView(props.shot, props.events);
  if (state === 'hidden') return null;
  const box = 'flex flex-col gap-1 rounded-md border px-2.5 py-2 text-[12px]';
  const limit = <p className="text-[11px] leading-snug text-muted-foreground">{MOTION_LIMIT}</p>;
  let body;
  if (state === 'waiting') {
    body = <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> Menunggu klip selesai — cek gerak jalan otomatis setelahnya.</p>;
  } else if (state === 'empty') {
    body = <p className="text-muted-foreground">Belum diperiksa. Klip yang baru selesai dicek otomatis; klip lama bisa dicek oleh admin.</p>;
  } else if (state === 'error') {
    body = <p className="text-muted-foreground">Cek gerak tidak bisa dijalankan untuk klip ini. Klip tetap bisa dipakai — tonton sendiri sebelum dirakit.</p>;
  } else if (motion) {
    const fix = motionSuggestions(motion);
    body = (
      <>
        <p className={cn('flex items-center gap-1.5 font-medium', state === 'fail' ? 'text-destructive' : state === 'warn' ? 'text-(--warning)' : 'text-(--success)')}>
          {state === 'ok' ? <CircleCheck aria-hidden="true" className="size-3.5" /> : <TriangleAlert aria-hidden="true" className="size-3.5" />}
          {state === 'fail' ? 'Perlu dicek' : state === 'warn' ? 'Catatan' : 'Tidak ada masalah gerak yang terdeteksi'}
          <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">skor {Math.round(motion.score)}/100</span>
        </p>
        {motion.reasons.length > 0 && <ul className="list-disc pl-4 leading-snug">{motion.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
        {fix.length > 0 && <ul aria-label="Perbaikan gratis" className="list-disc pl-4 leading-snug text-muted-foreground">{fix.map(f => <li key={f}>{f}</li>)}</ul>}
        {limit}
      </>
    );
  }
  return (
    <section aria-label="Cek gerak klip" data-motion={state} className={cn(box, state === 'fail' ? 'border-destructive/40 bg-destructive/5' : 'border-border/70 bg-(--field)')}>
      <h3 className="text-[11.5px] font-medium text-muted-foreground">Cek gerak klip</h3>
      {body}
    </section>
  );
}

/**
 * A spending step the assistant proposed: its label, the cost, and one click "Jalankan" (the only
 * way money or credits are spent from chat). "Lewati" hides it while the panel stays mounted (it is
 * not stored: closing the sheet, a reload or another project brings it back). A pending the
 * server will refuse (used, superseded, expired) is shown disabled with the reason.
 */
import { useState } from 'react';
import { Coins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { estimateText, PENDING_TTL_MS, type TurnPending } from './assistantClient.js';

export type PendingView = TurnPending & { refused?: string; final?: boolean };

/** Why this pending cannot run any more, if so. */
export function pendingBlocked(p: PendingView, now = Date.now(), currentRev?: number): string | undefined {
  if (p.superseded) return 'Sudah tidak berlaku';
  // The server only runs a pending at the revision it was proposed at: any later edit or undo ends it.
  if (typeof p.rev === 'number' && typeof currentRev === 'number' && currentRev > p.rev && !p.used) return 'Sudah tidak berlaku';
  if (p.used) return 'Sudah dijalankan';
  if (p.final) return p.refused ?? 'Sudah tidak berlaku';
  if (p.createdAt && now - Date.parse(p.createdAt) > PENDING_TTL_MS) return 'Sudah kedaluwarsa — minta ulang';
  return undefined;
}

export function PendingCard(props: { pending: PendingView; currentRev?: number; disabled?: boolean; onRun: () => Promise<void> | void; onSkip: () => void }) {
  const p = props.pending;
  const [running, setRunning] = useState(false);
  const blocked = pendingBlocked(p, Date.now(), props.currentRev);
  const cost = estimateText(p.estimate);
  return (
    <div role="group" aria-label={`Persetujuan: ${p.label}`}
      className={cn('mt-2 flex flex-col gap-2 rounded-lg bg-card/70 px-3 py-2.5 shadow-[0_1px_0_oklch(1_0_0/0.05),0_12px_32px_-16px_oklch(0_0_0/0.55)]', blocked && 'opacity-70')}>
      <div className="flex items-start gap-2">
        <Coins aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('text-[12.5px] leading-snug', blocked && 'text-muted-foreground')}>{p.label}</span>
          {!p.label.includes(cost) && <span className="text-[11.5px] text-muted-foreground tabular-nums">{cost}</span>}
        </div>
      </div>
      {blocked ? (
        <span role={p.final ? 'alert' : undefined} className={cn('text-[11.5px] text-muted-foreground', p.final && 'text-destructive')}>{blocked}</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button size="xs" disabled={props.disabled || running} aria-label={`Jalankan: ${p.label}`}
            onClick={() => { setRunning(true); Promise.resolve(props.onRun()).finally(() => setRunning(false)); }}>
            {running && <Loader2 aria-hidden="true" className="animate-spin" />} Jalankan
          </Button>
          <Button size="xs" variant="ghost" aria-label={`Lewati: ${p.label}`} onClick={props.onSkip}>Lewati</Button>
        </div>
      )}
      {p.refused && !blocked && <span role="alert" className="text-[11.5px] text-destructive">{p.refused}</span>}
    </div>
  );
}

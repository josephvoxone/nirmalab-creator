/**
 * What an assistant turn changed: one compact pill per change with "Batalkan". Undo restores the
 * snapshot before that turn; a refusal (a later edit, a render running) shows the server's words
 * under the chip and leaves the board alone.
 */
import { useState } from 'react';
import { Check, Loader2, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TurnChange } from './assistantClient.js';

export function ChangeChips(props: { changes: TurnChange[]; onUndo: (undoId: string) => Promise<string | undefined> }) {
  const [busy, setBusy] = useState<string>();
  const [refused, setRefused] = useState<Record<string, string>>({});
  if (!props.changes.length) return null;

  const undo = async (undoId: string) => {
    setBusy(undoId);
    setRefused(r => { const n = { ...r }; delete n[undoId]; return n; });
    const problem = await props.onUndo(undoId);
    setBusy(undefined);
    if (problem) setRefused(r => ({ ...r, [undoId]: problem }));
  };

  // Every change of one turn shares its undoId: Batalkan sits on the last chip of each group only.
  const last = new Map<string, number>();
  props.changes.forEach((c, i) => last.set(c.undoId, i));
  const lastOfGroup = new Set(last.values());
  const groupSize = (undoId: string) => props.changes.filter(c => c.undoId === undoId).length;
  return (
    <ul aria-label="Perubahan" className="mt-2 flex flex-col items-start gap-1">
      {props.changes.map((c, i) => (
        <li key={`${c.undoId}-${i}`} className="flex max-w-full flex-col items-start gap-0.5">
          <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 py-0.5 pr-1 pl-2 text-[12px]', c.undone && 'pr-2')}>
            {c.undone
              ? <Undo2 aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              : <Check aria-hidden="true" className="size-3 shrink-0 text-(--success)" />}
            <span className={cn('min-w-0 truncate', c.undone && 'text-muted-foreground line-through')}>{c.label}</span>
            {c.undone
              ? <span className="shrink-0 text-[11.5px] text-muted-foreground">Dibatalkan</span>
              : lastOfGroup.has(i) && (
                <button type="button" aria-label={groupSize(c.undoId) > 1 ? `Batalkan ${groupSize(c.undoId)} perubahan ini` : `Batalkan: ${c.label}`} disabled={busy === c.undoId} onClick={() => void undo(c.undoId)}
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:opacity-60">
                  {busy === c.undoId && <Loader2 aria-hidden="true" className="size-3 animate-spin" />} {groupSize(c.undoId) > 1 ? 'Batalkan semua' : 'Batalkan'}
                </button>
              )}
          </span>
          {refused[c.undoId] && lastOfGroup.has(i) && <span role="alert" className="pl-2 text-[11.5px] text-destructive">{refused[c.undoId]}</span>}
        </li>
      ))}
    </ul>
  );
}

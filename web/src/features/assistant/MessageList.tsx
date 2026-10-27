/**
 * The conversation, Claude/ChatGPT style: user messages right-aligned in a soft bubble with their
 * image attachments above; assistant messages full width as markdown next to a small mark (MCP
 * entries carry "MCP · <token name>" instead). A running turn shows one step line per tool call
 * and a shimmer until the first words arrive; change chips and pending cards sit under the text.
 */
import { useState } from 'react';
import { Check, Loader2, Plug, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { PREVIEW_WIDTH, sizedUrl, thumbProps, type Turn, type TurnAttachment } from './assistantClient.js';
import { ChangeChips } from './ChangeChips.js';
import { AssistantMarkdown } from './Markdown.js';
import { PendingCard, type PendingView } from './PendingCard.js';

/** What the client knows about a turn beyond the stored history (this session only). */
export type LiveState = {
  steps: string[];
  streaming: boolean;
  error?: { message: string; code?: string };
  /** Re-sends the same message (message turns only). */
  canRetry?: boolean;
};

export type MessageListProps = {
  turns: Turn[];
  live: Record<string, LiveState>;
  pendingState: Record<string, Partial<PendingView>>;
  skipped: Set<string>;
  busy: boolean;
  onUndo: (undoId: string) => Promise<string | undefined>;
  onRun: (pendingId: string, label: string) => Promise<void>;
  onSkip: (pendingId: string) => void;
  onRetry: (turnId: string) => void;
};

/** What the server stores as the text of a turn stopped mid-way (server/src/assistant/chat.ts). */
const CANCELLED_TEXT = 'Dibatalkan.';

export function Mark() {
  return (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-(--brand) text-[10px] font-bold text-(--brand-foreground)">N</span>
  );
}

function Attachments(props: { items: TurnAttachment[]; align?: 'end' | 'start' }) {
  const [open, setOpen] = useState<TurnAttachment>();
  if (!props.items.length) return null;
  return (
    <>
      <div className={cn('flex flex-wrap gap-1.5', props.align === 'end' && 'justify-end')}>
        {props.items.map((a, i) => (
          <button key={a.id} type="button" aria-label={`Lihat lampiran ${i + 1}`} onClick={() => setOpen(a)}
            className="size-16 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <img {...thumbProps(a.url)} alt={`Lampiran ${i + 1}`} width={64} height={64} loading="lazy" decoding="async" className="size-16 object-cover text-transparent" />
          </button>
        ))}
      </div>
      <Dialog open={!!open} onOpenChange={v => { if (!v) setOpen(undefined); }}>
        <DialogContent className="w-auto max-w-[min(92vw,720px)] p-3 sm:max-w-[min(92vw,720px)]">
          <DialogTitle className="sr-only">Pratinjau lampiran</DialogTitle>
          {open && <img src={sizedUrl(open.url, PREVIEW_WIDTH)} alt="Pratinjau lampiran" width={open.w || undefined} height={open.h || undefined} decoding="async"
            className="mx-auto block h-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function UserMessage(props: { turn: Turn }) {
  return (
    <li className="flex flex-col items-end gap-1.5" aria-label="Pesan kamu">
      <Attachments items={props.turn.attachments ?? []} align="end" />
      {props.turn.text && (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3 py-1.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-secondary-foreground">
          {props.turn.text}
        </div>
      )}
    </li>
  );
}

function AssistantMessage(props: MessageListProps & { turn: Turn }) {
  const { turn } = props;
  const live = props.live[turn.id];
  const mcp = turn.source === 'mcp';
  const error = live?.error;
  // A failed turn is stored with the error as its text: show it once, as the error line (a stopped
  // turn is stored as the server's "Dibatalkan." while this session says "Dihentikan.").
  const stored = turn.text.trim();
  const text = error && (stored === error.message.trim() || (error.code === 'CANCELLED' && stored === CANCELLED_TEXT)) ? '' : turn.text;
  const waiting = live?.streaming && !text;
  const pendings = (turn.pending ?? []).filter(p => !props.skipped.has(p.id)).map(p => ({ ...p, ...props.pendingState[p.id] }) as PendingView);
  return (
    <li className="flex flex-col gap-1" aria-label={mcp ? `Perubahan lewat MCP · ${turn.by ?? 'token'}` : 'Jawaban asisten'} aria-busy={live?.streaming || undefined}>
      {mcp ? (
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Plug aria-hidden="true" className="size-3" /> MCP · {turn.by ?? 'token'}</span>
      ) : (
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Mark /> Asisten</span>
      )}
      <div className="flex min-w-0 flex-col pl-[26px] max-[400px]:pl-0">
        {live?.streaming && live.steps.map((s, i) => (
          <span key={`${s}-${i}`} className="flex items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
            {i === live.steps.length - 1
              ? <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />
              : <Check aria-hidden="true" className="size-3 shrink-0 opacity-60" />} {s}…
          </span>
        ))}
        {waiting && !live.steps.length && <span aria-label="Asisten sedang menulis" className="shimmer w-fit py-0.5 text-[12.5px] text-muted-foreground">Sedang berpikir…</span>}
        {text && <AssistantMarkdown text={text} />}
        {error && (
          <span role="alert" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-destructive/90">
            <span>{error.message}</span>
            {live?.canRetry && !props.busy && (
              <button type="button" onClick={() => props.onRetry(turn.id)}
                className="inline-flex items-center gap-1 rounded-sm text-[12px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring/60">
                <RotateCcw aria-hidden="true" className="size-3" /> Coba lagi
              </button>
            )}
          </span>
        )}
        <ChangeChips changes={turn.changes ?? []} busy={props.busy} onUndo={props.onUndo} />
        {pendings.map(p => (
          <PendingCard key={p.id} pending={p} disabled={props.busy} onRun={() => props.onRun(p.id, p.label)} onSkip={() => props.onSkip(p.id)} />
        ))}
      </div>
    </li>
  );
}

export function MessageList(props: MessageListProps) {
  return (
    <ol role="log" aria-live="polite" aria-busy={props.busy || undefined} aria-label="Percakapan dengan asisten" className="flex flex-col gap-5">
      {props.turns.map(t => (t.role === 'user'
        ? <UserMessage key={t.id} turn={t} />
        : <AssistantMessage key={t.id} {...props} turn={t} />))}
    </ol>
  );
}

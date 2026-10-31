/**
 * The chat composer, ChatGPT style: one rounded pane holding the picked images (64 px chips with ×,
 * a spinner while uploading), the mention textarea (`@` characters, `#` locations, `/` shots and
 * scenes; 1–8 lines) and, on the bottom line, the paperclip and the send mark that turns into Stop
 * while a reply streams. Enter sends, Shift+Enter breaks the line, Escape while streaming stops.
 */
import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2, Paperclip, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MentionTextarea, type MentionTriggers } from '../../ui/MentionTextarea.js';
import type { Upload } from '../stories/storiesClient.js';
import { MAX_ATTACHMENTS, thumbProps } from './assistantClient.js';
import { COMPOSER_ID } from './ids.js';

/** `preview` is the local blob URL: shown while uploading and until the sized server thumbnail has loaded. */
export type Draft = { key: string; name: string; preview?: string; status: 'uploading' | 'done'; upload?: Upload };

export { COMPOSER_ID } from './ids.js';
export const PLACEHOLDER = 'Minta asisten… (@ karakter, # lokasi, / shot)';
const ACCEPT = 'image/png,image/jpeg,image/webp';

export type ComposerProps = {
  value: string;
  onChange: (v: string) => void;
  triggers: MentionTriggers;
  drafts: Draft[];
  onRemove: (key: string) => void;
  /** The sized server thumbnail of a draft has loaded: the local preview can go. */
  onLoaded: (key: string) => void;
  onFiles: (files: File[]) => void;
  problem?: string;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
};

export function Composer(props: ComposerProps) {
  const file = useRef<HTMLInputElement>(null);
  const uploading = props.drafts.some(d => d.status === 'uploading');
  const ready = !uploading && (props.value.trim().length > 0 || props.drafts.length > 0);
  const full = props.drafts.length >= MAX_ATTACHMENTS;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && props.streaming) {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
      props.onStop();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    props.onFiles(files);
  };

  return (
    <div className="flex flex-col gap-1">
      {props.problem && <p role="alert" className="px-1 text-[12px] text-destructive">{props.problem}</p>}
      <div onKeyDown={onKeyDown} onPaste={onPaste}
        className="glass-panel rounded-2xl px-2 pt-1.5 pb-1.5 transition-colors focus-within:ring-1 focus-within:ring-ring/40">
        {props.drafts.length > 0 && (
          <ul aria-label="Lampiran" className="flex flex-wrap gap-1.5 px-1 pt-1 pb-1.5">
            {props.drafts.map((d, i) => {
              const hide = (e: { currentTarget: HTMLImageElement }) => { e.currentTarget.style.visibility = 'hidden'; };
              return (
                <li key={d.key} className="group/att relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {d.preview && (
                    <img src={d.preview} alt="" width={64} height={64} decoding="async" onError={hide}
                      className={cn('absolute inset-0 size-16 object-cover text-transparent', d.status === 'uploading' && 'opacity-50')} />
                  )}
                  {d.upload && (
                    <img {...thumbProps(d.upload.url)} alt={`Lampiran ${i + 1}`} width={64} height={64} loading="lazy" decoding="async"
                      onLoad={() => props.onLoaded(d.key)} onError={hide}
                      className={cn('relative size-16 object-cover text-transparent', d.preview && 'opacity-0')} />
                  )}
                  {!d.preview && !d.upload && <span className="flex size-16 items-center justify-center px-1 text-center text-[10px] break-all text-muted-foreground">{d.name}</span>}
                  {d.status === 'uploading' && (
                    <span role="status" aria-label={`Mengunggah ${d.name}`} className="absolute inset-0 flex items-center justify-center">
                      <Loader2 aria-hidden="true" className="size-4 animate-spin text-foreground" />
                    </span>
                  )}
                  <button type="button" aria-label={`Hapus lampiran ${i + 1}`} onClick={() => props.onRemove(d.key)}
                    className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/85 text-foreground shadow-sm outline-none hover:bg-background focus-visible:ring-1 focus-visible:ring-ring">
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <MentionTextarea
          id={COMPOSER_ID}
          ariaLabel="Pesan untuk asisten"
          value={props.value}
          onChange={props.onChange}
          triggers={props.triggers}
          rows={1}
          maxRows={8}
          placeholder={PLACEHOLDER}
          onSubmit={() => { if (!props.streaming && ready) props.onSend(); }}
          className="border-0 bg-transparent px-1.5 py-1 text-[13px] leading-6 shadow-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap focus-visible:border-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-1 pt-0.5">
          <input ref={file} type="file" accept={ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1}
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) props.onFiles(files); }} />
          <button type="button" aria-label="Lampirkan gambar" title={full ? `Maksimal ${MAX_ATTACHMENTS} gambar` : 'Lampirkan gambar (PNG, JPEG, WebP, maks 10 MB)'}
            disabled={full} onClick={() => file.current?.click()}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:opacity-40">
            <Paperclip aria-hidden="true" className="size-4" />
          </button>
          {props.streaming ? (
            <button type="button" aria-label="Hentikan jawaban" onClick={props.onStop}
              className="ml-auto flex size-7 items-center justify-center rounded-full bg-foreground text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/60">
              <Square aria-hidden="true" className="size-2.5 fill-current" />
            </button>
          ) : (
            <button type="button" aria-label="Kirim pesan" disabled={!ready} onClick={props.onSend}
              className="ml-auto flex size-7 items-center justify-center rounded-full bg-foreground text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100">
              {uploading ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <ArrowUp aria-hidden="true" className="size-4" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

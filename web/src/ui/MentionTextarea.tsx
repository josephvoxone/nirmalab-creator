/**
 * A textarea with inline mentions: `@` characters, `#` locations, `/` shots and scenes. Typing a
 * trigger at the start of a word opens a list under (or above, near the bottom of the screen) the
 * field, filtered by what follows the trigger; ArrowUp/Down move, Enter/Tab pick, Escape closes,
 * a click picks too. A pick replaces `@que` with `item.insert` + a space. Enter (no Shift) calls
 * `onSubmit` only while the list is closed, so picking never sends a half-written message.
 * Shared by the shot sheet, the scene breakdown dialog and the project chat composer.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { textareaClass } from './controls.js';

export type MentionItem = { id: string; label: string; hint?: string; avatar?: string; insert: string };
export type MentionTrigger = '@' | '#' | '/';
export type MentionTriggers = Partial<Record<MentionTrigger, MentionItem[]>>;

export type MentionTextareaProps = {
  value: string;
  onChange: (value: string) => void;
  triggers: MentionTriggers;
  placeholder: string;
  ariaLabel: string;
  rows?: number;
  maxRows?: number;
  onSubmit?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  ariaInvalid?: boolean;
};

const MAX_ITEMS = 8;
const LIST_ROOM = 260;
/** The open mention: trigger char at `start`, the text typed after it up to the caret. */
type Query = { trigger: MentionTrigger; start: number; end: number; text: string };

/** The mention being typed just before the caret, if any (trigger at the start of a word). */
export function queryAt(value: string, caret: number, triggers: MentionTriggers): Query | undefined {
  const before = value.slice(0, caret);
  const m = /(^|\s)([@#/])([^\s@#/]{0,40})$/.exec(before);
  if (!m) return undefined;
  const trigger = m[2] as MentionTrigger;
  if (!triggers[trigger]?.length) return undefined;
  return { trigger, start: caret - m[3]!.length - 1, end: caret, text: m[3]! };
}

export function filterItems(items: MentionItem[], text: string): MentionItem[] {
  const q = text.toLowerCase();
  return items.filter(i => !q || i.label.toLowerCase().includes(q) || i.insert.toLowerCase().includes(q)).slice(0, MAX_ITEMS);
}

const initials = (label: string) => {
  const words = label.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
};

export function MentionTextarea(props: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<Query>();
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const caretAfter = useRef<number>(undefined);
  const rows = props.rows ?? 2;
  const maxRows = Math.max(rows, props.maxRows ?? 8);

  const items = useMemo(() => (query ? filterItems(props.triggers[query.trigger] ?? [], query.text) : []), [query, props.triggers]);
  const open = !!query && items.length > 0 && !props.disabled;
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const optionId = (i: number) => `${listId}-o${i}`;

  const look = (value: string, caret: number) => {
    const next = queryAt(value, caret, props.triggers);
    setQuery(next);
    if (next?.text !== query?.text || next?.trigger !== query?.trigger) setActive(0);
  };

  const pick = (item: MentionItem) => {
    if (!query) return;
    const value = props.value;
    const insert = `${item.insert} `;
    const next = value.slice(0, query.start) + insert + value.slice(query.end).replace(/^ /, '');
    caretAfter.current = query.start + insert.length;
    setQuery(undefined);
    props.onChange(next);
  };

  // Caret after a pick, once the new value is in the field.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caretAfter.current !== undefined) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = undefined;
    }
  }, [props.value]);

  // Auto-grow between `rows` and `maxRows`.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = 'auto';
    const min = rows * line + pad;
    const max = maxRows * line + pad;
    const h = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [props.value, rows, maxRows]);

  // Keep the list on screen: open upwards when there is no room below.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setAbove(below < LIST_ROOM && r.top > below);
  }, [open]);

  useEffect(() => { if (props.disabled) setQuery(undefined); }, [props.disabled]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME (Japanese, Chinese, Korean…) is composing: Enter/Tab/arrows confirm or move its candidates.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(items[activeIndex]!);
        return;
      }
      if (e.key === 'Escape') {
        // Close the list only: a surrounding sheet or dialog must stay open.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation?.();
        setQuery(undefined);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && props.onSubmit) {
      e.preventDefault();
      props.onSubmit(props.value);
    }
  };

  return (
    <div ref={wrap} className="relative w-full">
      <textarea
        ref={ref}
        id={props.id}
        role="combobox"
        aria-label={props.ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-invalid={props.ariaInvalid || undefined}
        rows={rows}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={e => { props.onChange(e.target.value); look(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
        onSelect={e => { const el = e.currentTarget; if (el.selectionStart === el.selectionEnd) look(el.value, el.selectionStart); }}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(undefined)}
        className={cn(textareaClass, 'min-h-0 resize-none', props.className)}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={query.trigger === '@' ? 'Karakter' : query.trigger === '#' ? 'Lokasi' : 'Shot dan scene'}
          className={cn('absolute right-0 left-0 z-50 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-[12.5px] text-popover-foreground shadow-lg ring-1 ring-foreground/10',
            above ? 'bottom-full mb-1' : 'top-full mt-1')}>
          {items.map((item, i) => (
            <li key={item.id} id={optionId(i)} role="option" aria-selected={i === activeIndex}
              onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(item)}
              className={cn('flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2', i === activeIndex && 'bg-accent text-accent-foreground')}>
              {item.avatar
                ? <img src={item.avatar} width={20} height={20} alt="" loading="lazy" decoding="async" className="size-5 shrink-0 rounded-full object-cover" />
                : <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9.5px] font-medium text-muted-foreground">{initials(item.label)}</span>}
              <span className="min-w-0 truncate">{item.label}</span>
              {item.hint && <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

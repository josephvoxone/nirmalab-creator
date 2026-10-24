/**
 * App-level controls on Solid Glass primitives, so no page ships a native <select>,
 * date input or ad-hoc radio row. One look, one keyboard model, everywhere.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import { id as idLocale } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type Opt<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };

/** A labelled dropdown. `label` names it for screen readers and, with `showLabel`, on screen. */
export function Choice<T extends string>(props: {
  label: string; value: T; options: Array<Opt<T>>; onChange: (v: T) => void;
  disabled?: boolean; showLabel?: boolean; className?: string; size?: 'sm' | 'default'; placeholder?: string;
}) {
  const items = useMemo(() => Object.fromEntries(props.options.map(o => [o.value, o.label])), [props.options]);
  const trigger = (
    <Select value={props.value === '' ? null : props.value} items={items} onValueChange={v => { if (v != null) props.onChange(v as T); }} disabled={props.disabled}>
      <SelectTrigger aria-label={props.label} size={props.size ?? 'default'} className={cn('min-w-32 bg-(--field)', props.className)}>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {props.options.map(o => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} label={o.label}>
            {o.hint ? (
              <span className="flex min-w-0 flex-col">
                <span>{o.label}</span>
                <span className="text-[11.5px] text-muted-foreground">{o.hint}</span>
              </span>
            ) : o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (!props.showLabel) return trigger;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{props.label}</span>
      {trigger}
    </div>
  );
}

/** A few mutually exclusive options shown at once (mode, ratio, range). */
export function Segmented<T extends string>(props: { name: string; value: T; options: Array<Opt<T>>; onChange: (v: T) => void; disabled?: boolean; className?: string }) {
  return (
    <div role="radiogroup" aria-label={props.name} className={cn('glass-well inline-flex rounded-md bg-muted p-0.5', props.className)}>
      {props.options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={props.value === o.value} disabled={props.disabled || o.disabled}
          title={o.hint} onClick={() => props.onChange(o.value)}
          className={cn('h-6.5 rounded-[6px] px-2.5 text-[12.5px] whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:opacity-50',
            props.value === o.value && 'glass-chosen text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`)
  .filter(t => t.endsWith(':00') || t.endsWith(':30'));
const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function formatWhen(d: Date) {
  return `${d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date + time in a popover calendar (local time). Past days are disabled. */
export function DateTimePicker(props: { label: string; value: Date | undefined; onChange: (d: Date) => void; now?: Date; disabled?: boolean; defaultTime?: string }) {
  const now = props.now ?? new Date();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<Date>();
  const time = props.value ? `${pad(props.value.getHours())}:${pad(props.value.getMinutes())}` : (props.defaultTime ?? '19:00');
  const at = (day: Date, t: string) => { const [h, m] = t.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={props.disabled} aria-label={`${props.label}: ${props.value ? formatWhen(props.value) : 'pilih tanggal'}`}
        className="flex h-8 items-center gap-2 rounded-md border border-input bg-(--field) px-2.5 text-[13px] outline-none hover:bg-input/50 focus-visible:border-ring disabled:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground">
        <CalendarDays aria-hidden="true" />
        <span className={cn(!props.value && 'text-muted-foreground')}>{props.value ? formatWhen(props.value) : 'Pilih tanggal & jam'}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2" aria-label={props.label}>
        <Calendar mode="single" locale={idLocale} selected={props.value} defaultMonth={props.value ?? now}
          disabled={{ before: startOfDay(now) }} onSelect={d => { if (d) { setDay(d); props.onChange(at(d, time)); } }} />
        <div className="flex items-center gap-2 border-t px-1 pt-2">
          <span className="text-[12px] text-muted-foreground">Jam</span>
          <Choice label="Jam" size="sm" value={TIMES.includes(time) ? time : '19:00'} options={TIMES.map(t => ({ value: t, label: t }))}
            onChange={t => props.onChange(at(props.value ?? day ?? now, t))} className="min-w-24" />
          <span className="ml-auto text-[11.5px] text-muted-foreground">WITA</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Numbered steps across the top of a flow. Only finished steps (and the current one) are clickable. */
export function Steps(props: { label: string; steps: string[]; current: number; onStep?: (i: number) => void; className?: string }) {
  return (
    <ol aria-label={props.label} className={cn('flex flex-wrap items-center gap-1', props.className)}>
      {props.steps.map((s, i) => {
        const done = i < props.current;
        const here = i === props.current;
        return (
          <li key={s} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className={cn('h-px w-5 bg-border', done || here ? 'bg-foreground/40' : '')} />}
            <button type="button" disabled={i > props.current} aria-current={here ? 'step' : undefined} onClick={() => props.onStep?.(i)}
              className={cn('flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none transition-colors enabled:hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-default',
                here && 'glass-chosen text-foreground', done && 'text-foreground/80')}>
              <span aria-hidden="true" className={cn('flex size-4.5 items-center justify-center rounded-full border text-[10.5px] tabular-nums',
                here && 'border-foreground bg-foreground text-background', done && 'border-foreground/40')}>
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              {s}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled block for forms: label on top, optional hint under it. */
export function Field(props: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1 text-[12px] text-muted-foreground', props.className)}>
      {props.label}
      {props.children}
      {props.hint && <span className="text-[11.5px] text-muted-foreground/80">{props.hint}</span>}
    </label>
  );
}

export const inputClass = 'h-8 w-full rounded-md border border-input bg-(--field) px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring';
export const textareaClass = 'min-h-24 w-full resize-y rounded-md border border-input bg-(--field) px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring';

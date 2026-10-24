import { useMemo, useState } from 'react';
import { Clapperboard, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Choice, Field, Segmented, inputClass, textareaClass } from '../../ui/controls.js';
import { TECHNIQUE_CATEGORIES, filterTechniques, promptWarnings, techniqueKey, type Technique } from './compose.js';

const LIST_LIMIT = 60;
export const DURATIONS = [4, 6, 8] as const;
const DURATION_OPTIONS = DURATIONS.map(s => ({ value: String(s), label: `${s} detik` }));
const CATEGORY_OPTIONS = [{ value: 'all', label: 'Semua kategori' }, ...TECHNIQUE_CATEGORIES.map(c => ({ value: c.key, label: c.label }))];
const ASPECT_OPTIONS = [{ value: '9:16' as const, label: '9:16', hint: 'Vertikal (Reels, TikTok, Shorts)' }, { value: '16:9' as const, label: '16:9', hint: 'Horizontal (YouTube)' }];

export type ComposerValue = {
  subject: string;
  character: string;
  style: string;
  negative: string;
  picked: Technique[];
  aspect: '9:16' | '16:9';
  duration: number;
};

/** Step 3: describe the shot; the final prompt updates live beside it. */
export function Composer(props: {
  kind: 'video' | 'image';
  value: ComposerValue;
  onChange: (patch: Partial<ComposerValue>) => void;
  techniques: Technique[];
  composed: string;
  presetName: string | undefined;
  busy: boolean;
  onQueue: () => void;
}) {
  const { value, onChange } = props;
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterTechniques(props.techniques, category, query).slice(0, LIST_LIMIT), [props.techniques, category, query]);
  const pickedKeys = useMemo(() => new Set(value.picked.map(techniqueKey)), [value.picked]);
  const warnings = useMemo(() => promptWarnings(value.picked), [value.picked]);
  const hasSubject = (value.subject.trim() || value.character.trim()).length > 0;
  const canQueue = !props.busy && hasSubject && props.composed.trim().length > 0;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-3">
        <section aria-label="Isi shot" className="glass-panel flex flex-col gap-3 rounded-lg p-3">
          <Field label="Subjek / aksi" hint="Satu kalimat: siapa, melakukan apa, di mana.">
            <textarea rows={3} maxLength={1200} value={value.subject} className={textareaClass}
              placeholder="mis. a paper boat drifting down a rainy street at dusk" onChange={e => onChange({ subject: e.target.value })} />
          </Field>
          <Field label="Karakter (deskripsi yang sama di setiap shot)">
            <input value={value.character} maxLength={300} className={inputClass}
              placeholder="mis. a woman in her thirties, yellow raincoat, short black hair" onChange={e => onChange({ character: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Style / grade">
              <input value={value.style} maxLength={300} className={inputClass} placeholder="mis. soft film grain, muted teal" onChange={e => onChange({ style: e.target.value })} />
            </Field>
            <Field label="Negative prompt (pisah koma)">
              <input value={value.negative} maxLength={400} className={inputClass} onChange={e => onChange({ negative: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Rasio</span>
              <Segmented name="Rasio" value={value.aspect} options={ASPECT_OPTIONS} onChange={aspect => onChange({ aspect })} />
            </div>
            {props.kind === 'video' && (
              <Choice showLabel label="Durasi" value={String(value.duration)} options={DURATION_OPTIONS} onChange={v => onChange({ duration: Number(v) })} className="min-w-28" />
            )}
          </div>
        </section>

        <section aria-labelledby="studio-tech-title" className="glass-panel flex flex-col gap-2.5 rounded-lg p-3">
          <div className="flex items-baseline gap-2">
            <h2 id="studio-tech-title" className="text-[13px] font-medium">Teknik sinematik</h2>
            <span className="text-[12px] text-muted-foreground">opsional · satu gerakan kamera per shot</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Choice label="Kategori teknik" value={category} options={CATEGORY_OPTIONS} onChange={setCategory} className="min-w-40" />
            <input type="search" aria-label="Cari teknik" value={query} placeholder="dolly, rim light, noir…" onChange={e => setQuery(e.target.value)}
              className={`${inputClass} min-w-40 flex-1`} />
          </div>
          {value.picked.length > 0 && (
            <ul aria-label="Teknik dipilih" className="flex flex-wrap gap-1">
              {value.picked.map(t => (
                <li key={techniqueKey(t)} className="flex h-6 items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-[12px]">
                  {t.n}
                  <Button size="icon-xs" variant="ghost" aria-label={`Hapus ${t.n}`} onClick={() => onChange({ picked: value.picked.filter(x => techniqueKey(x) !== techniqueKey(t)) })}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <ul aria-label="Daftar teknik" className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
            {visible.map(t => (
              <li key={techniqueKey(t)} className="flex items-center gap-2.5 py-1.5">
                {t.i ? <img src={t.i} alt="" loading="lazy" className="h-9 w-14 shrink-0 rounded object-cover" /> : null}
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-[13px] font-medium">{t.n}</b>
                  <p className="line-clamp-1 text-[12px] text-muted-foreground">{t.d}</p>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={`Tambah ${t.n}`} disabled={pickedKeys.has(techniqueKey(t))}
                  onClick={() => onChange({ picked: [...value.picked, t] })}>
                  <Plus />
                </Button>
              </li>
            ))}
            {visible.length === 0 && <li className="py-4 text-center text-[12.5px] text-muted-foreground">Tidak ada teknik yang cocok. Coba kata lain atau pilih Semua kategori.</li>}
          </ul>
        </section>
      </div>

      <aside aria-label="Prompt akhir" className="glass-panel flex h-fit flex-col gap-2.5 rounded-lg p-3 lg:sticky lg:top-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-medium">Prompt akhir</h2>
          {props.presetName && <Badge variant="secondary" className="ml-auto h-4.5 px-1.5 text-[10.5px]">{props.presetName}</Badge>}
        </div>
        <p data-testid="composed-prompt" className="max-h-72 overflow-y-auto rounded-md bg-muted/60 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/90">
          {props.composed || 'Tulis subjek lalu pilih teknik.'}
        </p>
        {warnings.map(w => <p key={w} role="note" className="text-[12px] text-amber-400">{w}</p>)}
        <p className="text-[12px] text-muted-foreground">
          {props.kind === 'image' ? `Gambar ${value.aspect} · gratis di Flow.` : `Video ${value.duration} detik ${value.aspect} · ±10 kredit Flow, dengan audio.`}
        </p>
        {!hasSubject && <p className="text-[12px] text-muted-foreground">Isi subjek atau karakter dulu supaya Flow tahu apa yang dirender.</p>}
        <Button variant="glass" data-strong="" disabled={!canQueue} onClick={props.onQueue}>
          <Clapperboard /> Antrekan ke Flow
          {props.kind === 'image' && <Badge variant="secondary" className="h-4.5 px-1.5 text-[10.5px]">Gratis</Badge>}
        </Button>
      </aside>
    </div>
  );
}

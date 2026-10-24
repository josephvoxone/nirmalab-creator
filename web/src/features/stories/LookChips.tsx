import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Aperture, Clapperboard, Loader2, Palette as PaletteIcon, RefreshCw, Sparkles, SunMedium, X } from 'lucide-react';
import { DEFAULT_LOOK, LIST_OF, optionOf, type Catalog, type CoverState, type Look, type LookKey, type Option, type Palette, type Template } from './catalog.js';

type Tab = { key: LookKey; label: string; hint: string };
type ChipDef = { id: string; label: string; icon: ReactNode; tabs: Tab[] };

export const CHIPS: ChipDef[] = [
  { id: 'style', label: 'Gaya visual', icon: <Sparkles size={16} />, tabs: [{ key: 'style', label: 'Gaya', hint: 'Satu gaya untuk semua shot, karakter dan keyframe' }] },
  { id: 'film', label: 'Film setup', icon: <Clapperboard size={16} />, tabs: [
    { key: 'genre', label: 'Genre', hint: 'Konvensi cerita yang diikuti model' },
    { key: 'era', label: 'Era', hint: 'Periode dan nuansa zaman' },
    { key: 'tempo', label: 'Tempo', hint: 'Banyaknya potongan cerita' }
  ] },
  { id: 'camera', label: 'Kamera', icon: <Aperture size={16} />, tabs: [
    { key: 'camera', label: 'Body', hint: 'Karakter film atau sensor' },
    { key: 'lens', label: 'Lensa', hint: 'Bokeh, flare dan kelembutan' },
    { key: 'aperture', label: 'Aperture', hint: 'Seberapa dalam fokusnya' }
  ] },
  { id: 'palette', label: 'Palet warna', icon: <PaletteIcon size={16} />, tabs: [{ key: 'palette', label: 'Palet', hint: 'Palet yang diikuti color grade' }] },
  { id: 'lighting', label: 'Pencahayaan', icon: <SunMedium size={16} />, tabs: [{ key: 'lighting', label: 'Skema', hint: 'Arah dan suasana cahaya' }] }
];

function summary(catalog: Catalog, look: Look, chip: ChipDef): string {
  const labels = chip.tabs
    .filter(t => t.key !== 'tempo' && (look[t.key] !== 'auto' || chip.tabs.length === 1))
    .map(t => optionOf(catalog, t.key, look[t.key])?.label ?? 'Auto');
  return labels.length ? labels.join(' · ') : 'Auto';
}

export function Swatches({ colors, className = 'swatches' }: { colors: string[]; className?: string }) {
  if (!colors.length) return null;
  return <span className={className} aria-hidden="true">{colors.map(c => <i key={c} style={{ background: c }} />)}</span>;
}

export function Dialog(props: { title: string; onClose: () => void; onReset?: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[aria-pressed="true"], [role="tab"][aria-selected="true"], button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div ref={ref} className={`studio-dialog${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{props.title}</h2>
          <div className="dialog-actions">
            {props.onReset && <button type="button" className="btn btn-sm" onClick={props.onReset}>Reset</button>}
            <button type="button" className="icon-btn" aria-label="Tutup" onClick={props.onClose}><X size={18} /></button>
          </div>
        </header>
        {props.children}
      </div>
    </div>
  );
}

function OptionCard({ option, selected, onPick }: { option: Option; selected: boolean; onPick: () => void }) {
  const swatches = (option as Palette).swatches;
  const extra = (option as { shots?: number }).shots;
  return (
    <button type="button" className={`option-card${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onPick}>
      {swatches && (swatches.length ? <Swatches colors={swatches} className="option-swatch" /> : <span className="option-swatch auto">Auto</span>)}
      <b>{option.label}</b>
      {(option.hint || extra) && <span>{option.hint ?? `${extra} shot`}</span>}
    </button>
  );
}

function LookDialog({ catalog, chip, look, onChange, onClose }: { catalog: Catalog; chip: ChipDef; look: Look; onChange: (p: Partial<Look>) => void; onClose: () => void }) {
  const [tab, setTab] = useState(chip.tabs[0]!.key);
  const current = chip.tabs.find(t => t.key === tab)!;
  const options = catalog[LIST_OF[tab]] as Option[];
  const reset = () => onChange(Object.fromEntries(chip.tabs.map(t => [t.key, DEFAULT_LOOK[t.key]])) as Partial<Look>);
  const single = chip.tabs.length === 1;
  return (
    <Dialog title={chip.label} onClose={onClose} onReset={reset} wide={chip.id === 'palette'}>
      <div className="dialog-body">
        {!single && (
          <nav className="dialog-tabs" role="tablist" aria-label={chip.label}>
            {chip.tabs.map(t => (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === tab} className={t.key === tab ? 'active' : ''} onClick={() => setTab(t.key)}>
                {t.label}
                <span aria-hidden="true">{optionOf(catalog, t.key, look[t.key])?.label ?? 'Auto'}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="dialog-panel" role={single ? undefined : 'tabpanel'}>
          <div className="dialog-panel-head"><b>{current.label}</b><span>{current.hint}</span></div>
          <div className={`option-grid${tab === 'palette' ? ' palettes' : ''}`}>
            {options.map(o => (
              <OptionCard key={o.id} option={o} selected={look[tab] === o.id} onPick={() => { onChange({ [tab]: o.id } as Partial<Look>); if (single) onClose(); }} />
            ))}
          </div>
          {!single && <div className="dialog-foot"><button type="button" className="btn btn-primary" onClick={onClose}>Selesai</button></div>}
        </div>
      </div>
    </Dialog>
  );
}

/** Higgsfield-style chip row: caption + current value, each opens its picker. */
export function LookChips({ catalog, look, onChange, disabled }: { catalog: Catalog; look: Look; onChange: (p: Partial<Look>) => void; disabled?: boolean }) {
  const [open, setOpen] = useState<string>();
  const chip = CHIPS.find(c => c.id === open);
  const palette = optionOf(catalog, 'palette', look.palette) as Palette | undefined;
  return (
    <>
      <div className="look-chips">
        {CHIPS.map(c => (
          <button key={c.id} type="button" className="look-chip" disabled={disabled} onClick={() => setOpen(c.id)}>
            <span className="look-chip-icon">{c.id === 'palette' && palette?.swatches.length ? <Swatches colors={palette.swatches} className="chip-swatch" /> : c.icon}</span>
            <span className="look-chip-text"><small>{c.label}</small><b>{summary(catalog, look, c)}</b></span>
          </button>
        ))}
      </div>
      {chip && <LookDialog catalog={catalog} chip={chip} look={look} onChange={onChange} onClose={() => setOpen(undefined)} />}
    </>
  );
}

export function TemplateCard({ template, catalog, selected, onPick, coverUrl, cover: coverState, onRegenerate }: {
  template: Template; catalog: Catalog; selected: boolean; onPick: () => void;
  coverUrl: string; cover?: CoverState; onRegenerate?: () => void;
}) {
  const palette = optionOf(catalog, 'palette', template.look.palette) as Palette | undefined;
  const style = optionOf(catalog, 'style', template.look.style)?.label;
  const shots = catalog.tempos.find(t => t.id === template.look.tempo)?.shots;
  const [failed, setFailed] = useState<string>();
  const cover = failed !== coverUrl;
  return (
    <div className="template-item">
    <button type="button" className={`template-card${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onPick}>
      <span className="template-cover" style={{ background: palette?.swatches.length ? `linear-gradient(135deg, ${palette.swatches.join(', ')})` : undefined }}>
        {cover && <img src={coverUrl} alt="" loading="lazy" onError={() => setFailed(coverUrl)} />}
        {coverState?.pending && <span className="template-cover-busy"><Loader2 size={14} className="spin" /> Membuat cover…</span>}
        <em>{template.mode === 'konsisten' ? 'Konsisten' : 'Cepat'}</em>
      </span>
      <b>{template.name}</b>
      <span>{template.tagline}</span>
      <small>{[style, palette?.id !== 'auto' ? palette?.label : undefined, shots ? `${shots} shot` : undefined].filter(Boolean).join(' · ')}</small>
    </button>
    {onRegenerate && (
      <button type="button" className="template-regen icon-btn" disabled={coverState?.pending}
        aria-label={`Buat ulang cover ${template.name}`} title={coverState?.error ? `Gagal: ${coverState.error}` : 'Buat ulang cover lewat antrean Flow (gratis)'}
        onClick={onRegenerate}>
        <RefreshCw size={14} />
      </button>
    )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Palette, Plus, X } from 'lucide-react';
import { Composer, ComposerFooter, ComposerFooterEnd, ComposerPick } from '@/components/ui/composer';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { useHistory } from '../../shell/history.js';
import { storiesApi, CREDITS_PER_SHOT } from '../stories/storiesClient.js';
import { DEFAULT_LOOK, optionOf, useCatalog, type Look } from '../stories/catalog.js';
import { LookChips } from '../stories/LookChips.js';
import '../stories/studio.css';
import { errorText } from '../settings/settingsClient.js';
import { readPrefs } from '../../lib/prefs.js';
import { CATEGORIES, TemplateCover, type CatTemplate } from '../templates/shared.js';

type Mode = 'konsisten' | 'cepat';
type Aspect = '9:16' | '16:9';

const MODES: Array<{ value: Mode; label: string; hint: string }> = [
  { value: 'konsisten', label: 'Konsisten', hint: 'Karakter dibuat sekali, keyframe gratis direview, baru dianimasikan. Wajah & kostum sama di semua shot.' },
  { value: 'cepat', label: 'Cepat', hint: 'Langsung teks ke video per shot. Cocok untuk faceless & b-roll.' }
];
const ASPECTS: Array<{ value: Aspect; label: string; hint: string }> = [
  { value: '9:16', label: '9:16', hint: 'Shorts, Reels, TikTok' },
  { value: '16:9', label: '16:9', hint: 'YouTube landscape' }
];
const SHOTS = ['4', '6', '8', '10', '12'] as const;

export default function HomePage() {
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const history = useHistory();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const load = useCallback(() => api.catalog(), [api]);
  const { catalog, covers, error: catalogError } = useCatalog(load, 0);
  const templates = (catalog?.templates ?? []) as CatTemplate[];

  const [prompt, setPrompt] = useState('');
  const [template, setTemplate] = useState<CatTemplate>();
  const [prefs] = useState(readPrefs);
  const [mode, setMode] = useState<Mode>(prefs.mode);
  const [aspect, setAspect] = useState<Aspect>(prefs.aspect);
  const [shots, setShots] = useState<(typeof SHOTS)[number]>(prefs.shots);
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [lookOpen, setLookOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = useCallback((t: CatTemplate) => {
    setTemplate(t);
    setLook({ ...DEFAULT_LOOK, ...t.look });
    setPrompt(t.example);
    setMode(t.mode);
    setAspect(t.aspect === '16:9' ? '16:9' : '9:16');
    setError('');
  }, []);

  useEffect(() => {
    const id = params.get('template');
    if (!id || !templates.length) return;
    const t = templates.find(x => x.id === id);
    if (t) pick(t);
    setParams({}, { replace: true });
  }, [params, templates, pick, setParams]);

  const submit = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { story } = await api.draft({ premise: text.trim(), shots: Number(shots), mode, aspect, look, ...(template ? { template: template.id } : {}) });
      history.reload();
      navigate(`/cerita/${story.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const credits = Number(shots) * CREDITS_PER_SHOT;
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const firstPerCategory = templates.filter(t => { const c = t.category ?? t.id; if (seen.has(c)) return false; seen.add(c); return true; });
    return [...firstPerCategory, ...templates.filter(t => !firstPerCategory.includes(t))].slice(0, 6);
  }, [templates]);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-4 pt-6 pb-16">
      <h2 className="mb-6 text-center text-[1.65rem] font-medium tracking-tight text-foreground">Mau bikin video apa hari ini?</h2>

      <Composer
        value={prompt}
        onValueChange={v => { setPrompt(v); if (error) setError(''); }}
        onSubmit={v => void submit(v)}
        running={busy}
        canSubmit={!busy && prompt.trim().length > 0}
        placeholder="Tulis premis cerita, misalnya: kucing oranye menunggu pemiliknya pulang…"
        textareaProps={{ 'aria-label': 'Prompt' }}
        sendLabel="Buat video"
        stopLabel="Sedang membuat draf"
        className="glass-panel"
        leading={(
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Pilih template" className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground aria-expanded:bg-accent">
              <Plus className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="max-h-96 w-72 overflow-y-auto">
              {templates.length === 0 && <DropdownMenuItem disabled>{catalogError ? 'Template tidak termuat' : 'Memuat template…'}</DropdownMenuItem>}
              {CATEGORIES.map(c => {
                const list = templates.filter(t => t.category === c.id);
                return list.length ? (
                  <DropdownMenuGroup key={c.id}>
                    <DropdownMenuLabel>{c.label}</DropdownMenuLabel>
                    {list.map(t => <DropdownMenuItem key={t.id} onClick={() => pick(t)}>{t.name}</DropdownMenuItem>)}
                  </DropdownMenuGroup>
                ) : null;
              })}
              {templates.some(t => !t.category) && (
                <DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  {templates.filter(t => !t.category).map(t => <DropdownMenuItem key={t.id} onClick={() => pick(t)}>{t.name}</DropdownMenuItem>)}
                </DropdownMenuGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        above={template && (
          <span data-slot="template-tag" className="glass-control flex h-7 items-center gap-1.5 rounded-md pr-1 pl-1 text-[12px]">
            <TemplateCover template={template} catalog={catalog} state={covers[template.id]} className="size-5 rounded-[5px]" />
            <span>{template.name}</span>
            <button type="button" aria-label={`Lepas template ${template.name}`} onClick={() => setTemplate(undefined)} className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
          </span>
        )}
      />
      <ComposerFooter className="mt-2">
        <ComposerPick label="Mode" value={mode} options={MODES} onValueChange={setMode} align="start" />
        <ComposerPick label="Rasio" value={aspect} options={ASPECTS} onValueChange={setAspect} align="start" />
        <ComposerPick label="Durasi" value={shots} options={SHOTS.map(s => ({ value: s, label: `${s} shot · ±${Number(s) * 6} dtk` }))} onValueChange={setShots} align="start" />
        <button type="button" aria-expanded={lookOpen} aria-controls="home-look" onClick={() => setLookOpen(v => !v)}
          className="glass-held flex h-6 items-center gap-1 rounded-sm px-1.5 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground aria-expanded:text-foreground">
          <Palette className="size-3" /> {catalog ? (optionOf(catalog, 'style', look.style)?.label ?? 'Gaya') : 'Gaya'}
        </button>
        <ComposerFooterEnd>
          <span className="text-[12px] text-muted-foreground max-sm:hidden" title="Gambar & keyframe gratis; hanya animasi video yang memakai kredit Flow">
            {mode === 'konsisten' ? 'Keyframe gratis · ' : ''}±{credits} kredit render
          </span>
        </ComposerFooterEnd>
      </ComposerFooter>
      {lookOpen && catalog && (
        <div id="home-look" className="mt-3"><LookChips catalog={catalog} look={look} onChange={patch => setLook(l => ({ ...l, ...patch }))} /></div>
      )}
      {error && <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">Draf gagal dibuat: {error}. Prompt kamu masih di atas — coba kirim lagi.</p>}

      <section className="mt-8" aria-label="Saran template">
        {catalogError && !catalog ? (
          <p className="text-center text-[13px] text-muted-foreground">Template tidak termuat — kamu tetap bisa menulis prompt sendiri.</p>
        ) : !catalog ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy="true" aria-label="Memuat template">
            {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}
          </div>
        ) : (
          <>
            <ul aria-label="Mulai dari template" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {suggestions.map(t => (
                <li key={t.id}>
                  <button type="button" onClick={() => pick(t)} aria-label={t.name} aria-pressed={template?.id === t.id}
                    className="group flex h-14 w-full items-center gap-2.5 rounded-lg border border-border/60 px-2 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent aria-pressed:glass-chosen">
                    <TemplateCover template={t} catalog={catalog} state={covers[t.id]} className="size-10 shrink-0 rounded-md" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] text-foreground">{t.name}</span>
                      <span className="truncate text-[11.5px] text-muted-foreground">{t.tagline}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => navigate('/template')} className="mx-auto mt-3 flex items-center gap-1 rounded-sm text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
              Lihat semua {templates.length} template <ArrowRight className="size-3.5" />
            </button>
          </>
        )}
      </section>
    </div>
  );
}

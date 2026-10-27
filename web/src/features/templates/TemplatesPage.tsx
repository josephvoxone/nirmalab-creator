import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImagePlus, MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useSession } from '../../lib/session.js';
import { storiesApi } from '../stories/storiesClient.js';
import { useCatalog } from '../stories/catalog.js';
import { errorText } from '../settings/settingsClient.js';
import { AspectMark, CATEGORIES, TemplateCover, type CatTemplate } from './shared.js';

const MODE_LABEL = { konsisten: 'Konsisten', cepat: 'Cepat' } as const;

export default function TemplatesPage() {
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const load = useCallback(() => api.catalog(), [api]);
  const { catalog, covers, error, reload: retry } = useCatalog(load);
  const [cat, setCat] = useState('semua');
  const [q, setQ] = useState('');
  const [busyCover, setBusyCover] = useState<string>();
  const [coverError, setCoverError] = useState('');
  const templates = (catalog?.templates ?? []) as CatTemplate[];

  const counts = useMemo(() => {
    const c: Record<string, number> = { semua: templates.length };
    for (const t of templates) if (t.category) c[t.category] = (c[t.category] ?? 0) + 1;
    return c;
  }, [templates]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return templates.filter(t => (cat === 'semua' || t.category === cat)
      && (!needle || `${t.name} ${t.tagline} ${t.example}`.toLowerCase().includes(needle)));
  }, [templates, cat, q]);
  const tabs = [{ id: 'semua', label: 'Semua' }, ...CATEGORIES.filter(c => counts[c.id])];

  const regenerate = async (id: string) => {
    setBusyCover(id);
    setCoverError('');
    try { await api.regenerateCover(id); retry(); } catch (e) { setCoverError(errorText(e)); } finally { setBusyCover(undefined); }
  };

  return (
    <div className="mx-auto w-full max-w-[1100px] pt-2">
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center">
        <p className="text-[13px] text-muted-foreground">Mulai dari resep yang sudah jadi: gaya visual, kamera, palet, tempo, dan contoh premis.</p>
        <label className="flex h-8 items-center gap-2 rounded-md border bg-(--field) px-2.5 sm:ml-auto sm:w-64 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          <Search aria-hidden="true" />
          <input type="search" aria-label="Cari template" placeholder="Cari template…" value={q} onChange={e => setQ(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      <p className="-mt-2 pb-4 text-[12.5px] text-muted-foreground">Template = resep untuk memulai proyek: gaya, tempo dan jumlah shot sudah diatur.</p>

      {catalog && (
        <div role="tablist" aria-label="Kategori" className="mb-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
          {tabs.map(t => (
            <button key={t.id} role="tab" type="button" aria-selected={cat === t.id} onClick={() => setCat(t.id)}
              className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent',
                cat === t.id && 'glass-chosen text-foreground')}>
              {t.label} <span className="text-[11px] text-muted-foreground">{counts[t.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {coverError && <p role="alert" className="mb-3 text-[13px] text-destructive">Cover gagal diantrikan: {coverError}</p>}

      {error && !catalog ? (
        <div role="alert" className="glass-panel mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-lg px-6 py-8 text-center">
          <b className="text-sm font-medium">Template tidak termuat</b>
          <p className="text-[13px] text-muted-foreground">{errorText(error)}. Server mungkin sedang restart.</p>
          <Button variant="glass" size="sm" onClick={retry}><RefreshCw /> Coba lagi</Button>
        </div>
      ) : !catalog ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-busy="true" aria-label="Memuat template">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-lg" />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-2 text-center">
          <b className="text-sm font-medium">Tidak ada template yang cocok</b>
          <p className="text-[13px] text-muted-foreground">Coba kata lain, atau tulis premis sendiri di Buat baru.</p>
          <Button variant="glass" size="sm" onClick={() => { setQ(''); setCat('semua'); }}>Tampilkan semua</Button>
        </div>
      ) : (
        <ul aria-label="Daftar template" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map(t => (
            <li key={t.id} aria-label={t.name} className="group glass-panel relative flex flex-col overflow-hidden rounded-lg">
              <TemplateCover template={t} catalog={catalog} state={covers[t.id]} width={240} height={300} className="aspect-[4/5] w-full" />
              {user.isAdmin && (
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label={`Menu template ${t.name}`}
                    render={<Button type="button" size="icon-xs" variant="glass" className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100" />}>
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem disabled={busyCover === t.id || !!covers[t.id]?.pending} onClick={() => void regenerate(t.id)} title="Lewat bridge, gratis">
                      <ImagePlus /> Buat ulang cover
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                <b className="truncate text-[13px] font-medium">{t.name}</b>
                <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">{t.tagline}</p>
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Badge variant="secondary" className="mr-auto h-4.5 px-1.5 text-[10.5px]">{MODE_LABEL[t.mode] ?? t.mode}</Badge>
                  <AspectMark aspect={t.aspect} />
                  <Button size="sm" variant="glass" data-strong="" onClick={() => navigate(`/?template=${t.id}`)} aria-label={`Pakai ${t.name}`}>Pakai</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

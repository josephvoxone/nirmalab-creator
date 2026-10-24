/**
 * /tren — what is working per country right now, deconstructed into the structure you can reuse
 * (spec §4.5–4.6). The filters are the URL, the grid is compact, and every card leads to one
 * drawer where the single action is "Jadikan proyek" (CloneBrief → draft project on the server).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Radio, RefreshCw, ScanSearch, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Choice, Segmented } from '../../ui/controls.js';
import { EmptyState, ErrorState } from '../../ui/states.js';
import { useSession } from '../../lib/session.js';
import { sizedImg } from '../../lib/media.js';
import { relativeTime } from '../settings/settingsClient.js';
import { TrendDrawer } from './TrendDrawer.js';
import {
  NICHES, RANGES, REGIONS, SORTS, SOURCE_LABEL, SOURCE_NEEDS, activeSources, aspectOf, filtersQuery, fmtCount, fmtDuration, fmtPct, fmtRate,
  hookLabel, missingEnv, readFilters, sortItems, trendsApi, type Filters, type Sort, type TrendItem, type TrendsResponse
} from './trendsClient.js';

/** Thumbnail boxes stay small on purpose (bounded media): a vertical short never fills the card. */
const BOX = { '9:16': { w: 78, className: 'h-[138px] w-[78px]' }, '16:9': { w: 188, className: 'h-[106px] w-[188px]' } } as const;

function TrendCard(props: { item: TrendItem; onOpen: () => void }) {
  const { item } = props;
  const [broken, setBroken] = useState(false);
  const aspect = aspectOf(item);
  const box = BOX[aspect];
  const still = sizedImg(item.thumbnail, box.w);
  const meta = [item.channel, SOURCE_LABEL[item.source], relativeTime(item.publishedAtMs)].filter(Boolean).join(' · ');
  const duration = fmtDuration(item.durationSec);
  return (
    <li aria-label={item.title} className="glass-panel flex items-start gap-2.5 rounded-lg p-2">
      <span className={cn('relative shrink-0 self-center overflow-hidden rounded-md bg-muted', box.className)}>
        {!broken && (
          <img src={still.src} srcSet={still.srcSet} width={box.w} height={aspect === '9:16' ? 138 : 106} alt="" loading="lazy" decoding="async"
            onError={() => setBroken(true)} className="absolute inset-0 size-full object-cover" />
        )}
        {broken && <TrendingUp aria-hidden="true" className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/50" />}
        {duration && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10.5px] tabular-nums text-white">{duration}</span>}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="line-clamp-2 text-[13px] leading-snug font-medium">{item.title}</p>
        <p className="truncate text-[11.5px] text-muted-foreground">{meta}</p>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground">
          <Badge variant="secondary" className="h-4.5 px-1.5 text-[10.5px]">{hookLabel(item.hook)}</Badge>
          <span className="tabular-nums">{fmtRate(item.velocity)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{fmtPct(item.engagement)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{fmtCount(item.views)} tayangan</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <Button size="sm" variant="glass" aria-label={`Bedah ${item.title}`} onClick={props.onOpen}><ScanSearch /> Bedah</Button>
          {item.score ? <span className="text-[10.5px] text-muted-foreground tabular-nums">skor {Math.round(item.score * 100)}</span> : null}
        </div>
      </div>
    </li>
  );
}

function CardSkeletons() {
  return (
    <div role="status" aria-busy="true" aria-label="Memuat tren" className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="glass-panel flex items-start gap-2.5 rounded-lg p-2">
          <Skeleton className="h-[138px] w-[78px] shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-7 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TrendsPage() {
  const { fetchImpl } = useSession();
  const api = useMemo(() => trendsApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params.toString());
  const query = filtersQuery(filters);
  const [data, setData] = useState<TrendsResponse>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [sort, setSort] = useState<Sort>('velocity');
  const [openId, setOpenId] = useState<string>();

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError(undefined);
    api.list(readFilters(`?${query}`)).then(r => { if (alive) setData(r); }, e => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [api, query, tick]);

  const setFilters = (patch: Partial<Filters>) => setParams(prev => new URLSearchParams(filtersQuery({ ...readFilters(prev.toString()), ...patch })), { replace: true });
  const reload = () => setTick(t => t + 1);

  const shown = useMemo(() => sortItems(data?.items ?? [], sort), [data, sort]);
  const open = data?.items.find(i => i.id === openId);
  const active = data ? activeSources(data) : [];
  const missing = data && !data.configured ? missingEnv(data) : [];

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <div className="flex flex-col gap-2 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
            Yang sedang laku per negara, sudah dibedah jadi struktur: hook, peta beat, irama shot. <span className="text-foreground/70">Tiru strukturnya, bukan videonya.</span>
          </p>
          {active.length > 0 && (
            <Badge variant="outline" aria-label="Sumber aktif" className="h-5 shrink-0 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground">
              <Radio aria-hidden="true" />
              {active.map(s => SOURCE_LABEL[s]).join(', ')}
              {data?.generatedAtMs ? <span className="tabular-nums">{' · '}{relativeTime(data.generatedAtMs)}</span> : null}
            </Badge>
          )}
        </div>

        {data?.configured !== false && (
          <div className="flex flex-wrap items-center gap-2">
            <Choice label="Negara" size="sm" value={filters.region} options={REGIONS} onChange={region => setFilters({ region })} />
            <Segmented name="Jendela waktu" value={filters.range} options={RANGES} onChange={range => setFilters({ range })} />
            <Segmented name="Niche" value={filters.niche} options={NICHES} onChange={niche => setFilters({ niche })} className="flex-wrap" />
            <Choice label="Urutkan" size="sm" value={sort} options={SORTS} onChange={setSort} className="sm:ml-auto" />
          </div>
        )}
      </div>

      {error && !data ? (
        <ErrorState title="Gagal memuat tren" error={error} onRetry={reload} />
      ) : !data ? (
        <CardSkeletons />
      ) : !data.configured ? (
        <div className="flex min-h-[52vh] items-center">
        <div className="glass-panel flex w-full max-w-xl flex-col gap-3 rounded-lg px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">Nyalakan satu sumber dulu</h2>
            <p className="text-[13px] text-muted-foreground">
              Tren dibaca dari sumber resmi, bukan dikarang. Isi salah satu env di server, restart, lalu periksa lagi — tidak perlu semua sekaligus.
            </p>
          </div>
          <ul className="flex flex-col gap-1.5">
            {missing.map(({ source, env }) => (
              <li key={source} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-border/60 px-2.5 py-1.5">
                <span className="w-16 shrink-0 text-[12px] font-medium">{SOURCE_LABEL[source] ?? source}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{env}</code>
                <span className="text-[12px] text-muted-foreground">{SOURCE_NEEDS[source] ?? 'sumber tren'}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="glass" onClick={reload}><RefreshCw /> Periksa lagi</Button>
            <span className="text-[12px] text-muted-foreground">Mengubah env butuh restart server, bukan muat ulang halaman.</span>
          </div>
        </div>
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          title="Belum ada data tren untuk filter ini"
          reason="Jendela waktu ini belum punya tren yang lolos skor. Coba 7 hari atau niche lain — tarikan baru muncul setelah server menarik data."
          icon={<TrendingUp size={20} />}
          action={<Button size="sm" variant="glass" onClick={reload}><RefreshCw /> Muat ulang</Button>}
        />
      ) : (
        <ul aria-label="Daftar tren" className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {shown.map(item => <TrendCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />)}
        </ul>
      )}

      <TrendDrawer item={open} onClose={() => setOpenId(undefined)} onCloned={id => navigate(`/cerita/${id}`)} />
    </div>
  );
}

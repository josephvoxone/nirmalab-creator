/**
 * Sidebar quota (GET /api/quota, docs/providers-and-media.md §3): Flow credits + today's
 * use against the daily cap, OpenRouter balance when configured, server storage. Refreshes
 * every 60 s; a failed refresh keeps the last numbers.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { requestJson } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { LoadingState, describeError } from '../ui/states.js';

export type Quota = {
  flow: {
    credits: number | null; usedToday: number; capToday: number | null; accounts: number; online: boolean;
    /** Clips rendering now / parked until an account refills, and when the first refill is due. */
    running: number; waiting: number; resumeAtMs: number | null;
    pool: Array<{ label: string; credits: number | null; refillAtMs: number | null }>;
  };
  openrouter: { configured: boolean; remainingUsd: number | null; usedUsd: number | null };
  storage: { usedBytes: number; diskFreeBytes: number | null };
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read the reply defensively: an older server (or a catch-all fake) may return `{}`. */
export function readQuota(r: unknown): Quota {
  const q = (r ?? {}) as Partial<Record<keyof Quota, Record<string, unknown>>>;
  return {
    flow: {
      credits: num(q.flow?.credits), usedToday: num(q.flow?.usedToday) ?? 0, capToday: num(q.flow?.capToday), accounts: num(q.flow?.accounts) ?? 0, online: !!q.flow?.online,
      running: num(q.flow?.running) ?? 0, waiting: num(q.flow?.waiting) ?? 0, resumeAtMs: num(q.flow?.resumeAtMs),
      pool: (Array.isArray(q.flow?.pool) ? q.flow.pool as Array<Record<string, unknown>> : [])
        .map(p => ({ label: typeof p?.label === 'string' ? p.label : 'Akun', credits: num(p?.credits), refillAtMs: num(p?.refillAtMs) }))
    },
    openrouter: { configured: !!q.openrouter?.configured, remainingUsd: num(q.openrouter?.remainingUsd), usedUsd: num(q.openrouter?.usedUsd) },
    storage: { usedBytes: num(q.storage?.usedBytes) ?? 0, diskFreeBytes: num(q.storage?.diskFreeBytes) }
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(n: number): string {
  let v = Math.max(0, n);
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  const digits = u === 0 || v >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits }).format(v)} ${UNITS[u]}`;
}

const credits = (n: number) => new Intl.NumberFormat('id-ID').format(n);
const usd = (n: number) => `$${n.toFixed(2)}`;

const row = 'flex h-5 w-full items-center gap-1.5 text-left';

function FlowRow(props: { q: Quota['flow']; onOpen?: () => void }) {
  const { q } = props;
  const body = (
    <>
      <i aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', q.online ? 'bg-(--success)' : 'bg-destructive')} />
      <span className="truncate">{q.online ? 'Flow online' : 'Flow offline · render menunggu Mac'}</span>
      {q.credits !== null && <span className="ml-auto shrink-0 tabular-nums text-foreground/85">{credits(q.credits)} kredit</span>}
    </>
  );
  const hint = `Sisa kredit Google Flow di ${q.accounts} akun aktif`;
  return props.onOpen
    ? <button type="button" title={`${hint} · buka Akun Flow`} onClick={props.onOpen} className={cn(row, 'rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60')}>{body}</button>
    : <div title={hint} className={row}>{body}</div>;
}

/** WITA clock time, e.g. "17.00". */
const clock = (ms: number) => new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' }).format(ms);
/** "±8 j 20 m" until a moment; "sebentar lagi" once it is due. */
function waitText(ms: number, now: number): string {
  const left = Math.round((ms - now) / 60_000);
  if (left <= 1) return 'sebentar lagi';
  const h = Math.floor(left / 60), m = left % 60;
  return `±${h ? `${h} j ` : ''}${m} m`;
}

/** Rendering now, or clips parked until an account refills (they resume by themselves). Hidden when idle. */
function RenderStatus(props: { q: Quota['flow'] }) {
  const { running, waiting, resumeAtMs, pool } = props.q;
  if (!running && !waiting) return null;
  const now = Date.now();
  const accounts = pool.map(p => `${p.label}: ${p.credits ?? '?'} kredit${p.refillAtMs ? ` · isi ulang ±${clock(p.refillAtMs)}` : ''}`).join('\n');
  const title = [
    waiting ? `${waiting} klip menunggu kredit Flow; lanjut otomatis${resumeAtMs ? ` ±${clock(resumeAtMs)} WITA` : ' saat kredit terisi'} (kredit gratis 50/hari, isi ulang 24 jam setelah generate pertama).` : `${running} klip sedang dirender di Flow.`,
    accounts
  ].filter(Boolean).join('\n');
  return (
    <div role="status" aria-label="Status render" title={title} className={row}>
      <i aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', running ? 'animate-pulse bg-(--brand)' : 'bg-amber-400')} />
      <span className="truncate">{running ? `Merender ${running} klip` : `${waiting} klip menunggu kredit`}</span>
      {!running && resumeAtMs !== null && <span className="ml-auto shrink-0 tabular-nums text-foreground/85">{waitText(resumeAtMs, now)}</span>}
      {running > 0 && waiting > 0 && <span className="ml-auto shrink-0 tabular-nums">+{waiting} antre</span>}
    </div>
  );
}

function TodayBar(props: { q: Quota['flow'] }) {
  const { usedToday, capToday } = props.q;
  if (capToday === null || capToday <= 0) {
    return <p title="Kredit Flow yang terpakai hari ini (WITA)" className="text-[11px] tabular-nums">{credits(usedToday)} terpakai hari ini</p>;
  }
  const pct = Math.min(100, Math.round((usedToday / capToday) * 100));
  return (
    <div title="Kredit Flow terpakai hari ini dari batas harian (WITA)" className="flex items-center gap-2">
      <div role="progressbar" aria-label="Kredit Flow hari ini" aria-valuemin={0} aria-valuemax={capToday} aria-valuenow={usedToday}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full rounded-full', pct >= 90 ? 'bg-destructive' : 'bg-foreground/60')} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums">Hari ini {credits(usedToday)}/{credits(capToday)}</span>
    </div>
  );
}

export function SidebarQuota(props: { pollMs?: number }) {
  const { user, fetchImpl } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<Quota>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => requestJson<unknown>(fetchImpl, '/api/quota').then(
      r => { if (alive) { setData(readQuota(r)); setError(undefined); } },
      e => { if (alive) setError(e); }
    );
    void load();
    const ms = props.pollMs ?? 60_000;
    const timer = ms ? setInterval(load, ms) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [fetchImpl, tick, props.pollMs]);

  const retry = () => setTick(t => t + 1);
  const openFlow = user.isAdmin ? () => navigate('/pengaturan/flow', { state: { background: (location.state as { background?: unknown } | null)?.background ?? location } }) : undefined;

  return (
    <section aria-label="Kuota" className="flex flex-col gap-1 px-2 py-1 text-[11.5px] text-muted-foreground">
      {data ? (
        <>
          <FlowRow q={data.flow} onOpen={openFlow} />
          <RenderStatus q={data.flow} />
          <TodayBar q={data.flow} />
          {data.openrouter.configured && (
            <div title="Saldo OpenRouter untuk naskah & suara" className={row}>
              <span className="truncate">OpenRouter</span>
              <span className="ml-auto shrink-0 tabular-nums text-foreground/85">
                {data.openrouter.remainingUsd !== null ? `${usd(data.openrouter.remainingUsd)} sisa` : data.openrouter.usedUsd !== null ? `${usd(data.openrouter.usedUsd)} terpakai` : 'aktif'}
              </span>
            </div>
          )}
          <div title="Ruang terpakai di server · sisa ruang disk" className={row}>
            <span className="truncate">Penyimpanan</span>
            <span className="ml-auto shrink-0 tabular-nums">
              <span className="text-foreground/85">{formatBytes(data.storage.usedBytes)}</span>
              {data.storage.diskFreeBytes !== null && <> · {formatBytes(data.storage.diskFreeBytes)} kosong</>}
            </span>
          </div>
          {error !== undefined && <p title={describeError(error)} className="text-[11px] text-muted-foreground/80">Gagal diperbarui · angka terakhir</p>}
        </>
      ) : error !== undefined ? (
        <p className={row} title={describeError(error)}>
          <span className="truncate">Kuota tidak terbaca</span>
          <button type="button" aria-label="Muat ulang kuota" onClick={retry} className="ml-auto shrink-0 rounded-sm text-foreground/80 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60">Coba lagi</button>
        </p>
      ) : (
        <LoadingState label="Memuat kuota" className="flex flex-col gap-1.5 py-0.5">
          <Skeleton className="h-3 w-4/5" /><Skeleton className="h-1 w-full" /><Skeleton className="h-3 w-3/5" />
        </LoadingState>
      )}
    </section>
  );
}

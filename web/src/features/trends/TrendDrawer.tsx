/**
 * The "Bedah" drawer: what the structure of one trending video is, and the one action that
 * turns it into a project of your own (§4.5 CloneBrief). Hints stay honest — a section that
 * the deconstruction could not fill says so instead of showing a guess.
 */
import { useState, type ReactNode } from 'react';
import { ExternalLink, Loader2, RefreshCw, Wand2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useSession } from '../../lib/session.js';
import { sizedImg } from '../../lib/media.js';
import { describeError } from '../../ui/states.js';
import { relativeTime } from '../settings/settingsClient.js';
import {
  SOURCE_LABEL, audioLabel, captionLabel, fmtCount, fmtDuration, fmtPct, fmtRate, hookLabel, hookNote, rhythmOf, suggestLook, trendsApi,
  type TrendItem
} from './trendsClient.js';

function Row(props: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 py-1 text-[12.5px] last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 text-right">{props.value}</span>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** Proportional strip + rows: where each beat starts and how long it holds. */
function BeatMap(props: { item: TrendItem }) {
  const beats = (props.item.beats ?? []).filter(b => Number.isFinite(b.atSec));
  if (!beats.length) return <p className="text-[12.5px] text-muted-foreground">Peta beat belum ada untuk video ini.</p>;
  const end = Math.max(props.item.durationSec ?? 0, ...beats.map(b => b.atSec), 1);
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="flex h-1.5 w-full gap-px overflow-hidden rounded-full">
        {beats.map((b, i) => {
          const next = beats[i + 1]?.atSec ?? end;
          return <span key={`${b.atSec}-${i}`} className={i % 2 ? 'bg-foreground/55' : 'bg-foreground/25'} style={{ flexGrow: Math.max(next - b.atSec, 0.5) }} />;
        })}
      </div>
      <ol aria-label="Peta beat" className="flex flex-col">
        {beats.map((b, i) => (
          <li key={`${b.atSec}-${i}`} className="flex items-baseline gap-2 text-[12.5px]">
            <span className="w-9 shrink-0 text-muted-foreground tabular-nums">{fmtDuration(b.atSec)}</span>
            <span className="min-w-0">{b.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TrendDrawer(props: { item?: TrendItem; onClose: () => void; onCloned: (storyId: string) => void }) {
  const { fetchImpl } = useSession();
  const api = trendsApi(fetchImpl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const item = props.item;

  const clone = async () => {
    if (!item) return;
    setBusy(true);
    setError('');
    try {
      const { story } = await api.clone(item.id);
      props.onCloned(story.id);
    } catch (e) {
      setError(`Gagal membuat proyek: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const look = item ? suggestLook(item) : null;
  const rhythm = item ? rhythmOf(item) : null;
  const caption = captionLabel(item?.captionStyle);
  const audio = audioLabel(item?.audioType);
  const still = item ? sizedImg(item.thumbnail, 360) : undefined;

  return (
    <Sheet open={!!item} onOpenChange={o => { if (!o) props.onClose(); }}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md" aria-label={item ? `Bedah ${item.title}` : 'Bedah tren'}>
        {item && (
          <>
            <SheetHeader className="shrink-0 flex-row items-start gap-2 border-b p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <SheetTitle className="text-[14px] leading-snug">{item.title}</SheetTitle>
                <SheetDescription className="truncate text-[11.5px]">
                  {[item.channel, SOURCE_LABEL[item.source], item.publishedAtMs ? relativeTime(item.publishedAtMs) : '', item.durationSec ? fmtDuration(item.durationSec) : ''].filter(Boolean).join(' · ')}
                </SheetDescription>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="Tutup bedah" onClick={props.onClose}><X /></Button>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 [scrollbar-width:thin]">
              <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Buka ${item.title} di ${SOURCE_LABEL[item.source]}`}
                className="group relative flex max-h-[190px] justify-center overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
                <img src={still?.src} srcSet={still?.srcSet} alt="" loading="lazy" decoding="async" className="max-h-[190px] w-auto object-contain" />
                <span aria-hidden="true" className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1 text-[10.5px] tabular-nums text-white">{item.durationSec ? fmtDuration(item.durationSec) : ''}</span>
                <span aria-hidden="true" className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <ExternalLink className="size-3" /> Buka aslinya
                </span>
              </a>

              <div className="grid grid-cols-3 gap-2 text-[12px]">
                {[['Tayangan', fmtCount(item.views)], ['Naik', item.velocity > 0 ? fmtRate(item.velocity) : '—'], ['Interaksi', item.engagement > 0 ? fmtPct(item.engagement) : '—'],
                  ['Suka', item.likes ? fmtCount(item.likes) : '—'], ['Komentar', item.comments ? fmtCount(item.comments) : '—'], ['Skor', item.score ? `${Math.round(item.score)}/100` : '—']]
                  .map(([label, value]) => (
                    <div key={label} className="glass-well flex flex-col rounded-md px-2 py-1">
                      <span className="text-[10.5px] text-muted-foreground">{label}</span>
                      <span className="tabular-nums">{value}</span>
                    </div>
                  ))}
              </div>

              <Section title="Hook">
                <div className="flex items-start gap-2">
                  <Badge variant="secondary" className="mt-px h-4.5 shrink-0 px-1.5 text-[10.5px]">{hookLabel(item.hook)}</Badge>
                  <p className="min-w-0 text-[12.5px] text-muted-foreground">{hookNote(item.hook)}</p>
                </div>
              </Section>

              <Section title="Peta beat"><BeatMap item={item} /></Section>

              <Section title="Irama">
                {rhythm
                  ? <p className="text-[12.5px]">{rhythm}</p>
                  : <p className="text-[12.5px] text-muted-foreground">Jumlah shot belum dihitung untuk video ini.</p>}
                {rhythm && item.avgShotSec !== undefined && item.avgShotSec > 0 && item.avgShotSec < 1.5 && (
                  <p className="text-[11.5px] text-muted-foreground">Potongan secepat ini butuh lebih banyak shot daripada 6 detik per klip.</p>
                )}
              </Section>

              {(caption || audio || look) && (
                <Section title="Gaya & audio">
                  <div className="flex flex-col">
                    {caption && <Row label="Caption" value={caption} />}
                    {audio && <Row label="Audio" value={audio} />}
                    {look && <Row label="Look disarankan" value={look} />}
                  </div>
                </Section>
              )}

              <p className="text-[11.5px] text-muted-foreground">
                Metrik dari {SOURCE_LABEL[item.source]} · {relativeTime(item.publishedAtMs)}. Video asli tidak disimpan atau diunggah ulang.
              </p>
            </div>

            <SheetFooter className="mt-0 shrink-0 gap-2 border-t p-3">
              {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
              <Button className="w-full" onClick={() => void clone()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Jadikan proyek
              </Button>
              <p className="text-[11.5px] text-muted-foreground">Proyek draft dengan struktur, irama dan look yang sama — cerita dan asetnya baru.</p>
              {error && <Button size="sm" variant="glass" onClick={() => void clone()}><RefreshCw /> Coba lagi</Button>}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

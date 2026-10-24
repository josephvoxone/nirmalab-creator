/**
 * Publish: three steps. Video (a finished story) → Detail (title, text, visibility,
 * which connected platforms) → Kirim (now or, YouTube only, on a schedule) and the
 * result per platform. Connecting accounts lives in Settings → Koneksi.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Film, Link2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { useSession } from '../../lib/session.js';
import { poster } from '../../lib/media.js';
import { DateTimePicker, Field, formatWhen, inputClass, Segmented, Steps, textareaClass } from '../../ui/controls.js';
import { describeError, LoadingState } from '../../ui/states.js';
import {
  CAN_SCHEDULE, PLATFORM_LABEL, publishApi, publishErrorText, VISIBILITY_LABEL,
  type Platform, type PublisherStatus, type PublishResult, type StorySummary, type Visibility
} from './publishClient.js';

const STEPS = ['Video', 'Detail', 'Kirim'];
const VISIBILITIES: Visibility[] = ['public', 'unlisted', 'private'];

type Outcome = { state: 'sending' } | { state: 'ok'; result: PublishResult } | { state: 'error'; message: string };

const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const joinNames = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} dan ${names[names.length - 1]}`;

function Poster(props: { id: string; className?: string }) {
  return (
    <img src={poster.final(props.id, 480)} alt="" aria-hidden="true" loading="lazy" decoding="async"
      className={cn('pointer-events-none w-full bg-black/40 object-cover', props.className)} />
  );
}

function Panel(props: { children: React.ReactNode; className?: string }) {
  return <div className={cn('glass-panel rounded-lg p-4', props.className)}>{props.children}</div>;
}

function Empty(props: { title: string; reason: string; action: React.ReactNode }) {
  return (
    <div className="mx-auto mt-8 flex max-w-sm flex-col items-center gap-2 text-center">
      <h3 className="text-sm font-medium">{props.title}</h3>
      <p className="text-[13px] text-muted-foreground">{props.reason}</p>
      {props.action}
    </div>
  );
}

function Failed(props: { what: string; error: unknown; onRetry: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={cn('flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive', !props.compact && 'mx-auto mt-8 max-w-md')}>
      <span className="min-w-0 flex-1">{props.what} gagal dimuat. {describeError(props.error)}</span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}><RotateCcw /> Coba lagi</Button>
    </div>
  );
}

export default function PublishPage(props: { now?: Date }) {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => publishApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const location = useLocation();
  const now = useCallback(() => props.now ?? new Date(), [props.now]);

  const [stories, setStories] = useState<StorySummary[]>();
  const [storiesError, setStoriesError] = useState<unknown>();
  const [statuses, setStatuses] = useState<PublisherStatus[]>();
  const [statusError, setStatusError] = useState<unknown>();

  const [step, setStep] = useState(0);
  const [storyId, setStoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('unlisted');
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [when, setWhen] = useState<'now' | 'schedule'>('now');
  const [publishAt, setPublishAt] = useState<Date>();
  const [outcomes, setOutcomes] = useState<Partial<Record<Platform, Outcome>>>({});
  const [sending, setSending] = useState(false);

  const loadStories = useCallback(async () => {
    setStoriesError(undefined);
    try { setStories((await api.stories()).filter(s => s.status === 'done')); } catch (e) { setStoriesError(e); }
  }, [api]);
  const loadStatuses = useCallback(async () => {
    setStatusError(undefined);
    try { setStatuses(await api.status()); } catch (e) { setStatusError(e); }
  }, [api]);
  useEffect(() => { void loadStories(); void loadStatuses(); }, [loadStories, loadStatuses]);

  const connected = useMemo(() => (statuses ?? []).filter(s => s.connected), [statuses]);
  // Platforms that disconnected meanwhile drop out of the selection.
  const targets = chosen.filter(p => connected.some(s => s.platform === p));
  const story = stories?.find(s => s.id === storyId);
  const noSchedule = targets.filter(p => !CAN_SCHEDULE[p]).map(p => PLATFORM_LABEL[p]);
  const scheduling = when === 'schedule' && noSchedule.length === 0;
  const scheduleInPast = scheduling && !!publishAt && publishAt.getTime() <= now().getTime();
  const pending = targets.filter(p => outcomes[p]?.state !== 'ok');
  const ran = Object.keys(outcomes).length > 0;

  const resetRun = () => setOutcomes({});

  const pickStory = (s: StorySummary) => {
    if (s.id !== storyId) { setTitle(s.title); resetRun(); }
    setStoryId(s.id);
    if (chosen.length === 0) setChosen(connected.map(c => c.platform));
    setStep(1);
  };

  const toggle = (p: Platform, on: boolean) => {
    resetRun();
    setChosen(c => on ? [...c.filter(x => x !== p), p] : c.filter(x => x !== p));
  };

  const send = async () => {
    if (!story || !title.trim()) return;
    const list = ran ? pending : targets;
    const at = scheduling && publishAt ? publishAt.toISOString() : undefined;
    setSending(true);
    setOutcomes(o => ({ ...o, ...Object.fromEntries(list.map(p => [p, { state: 'sending' }])) }));
    for (const p of list) {
      try {
        const result = await api.publish(p, { storyId: story.id, title: title.trim(), description, visibility, ...(at && p === 'youtube' ? { publishAt: at } : {}) });
        setOutcomes(o => ({ ...o, [p]: { state: 'ok', result } }));
      } catch (e) {
        setOutcomes(o => ({ ...o, [p]: { state: 'error', message: publishErrorText(p, e) } }));
      }
    }
    setSending(false);
  };

  const startOver = () => {
    resetRun();
    setStoryId(''); setTitle(''); setDescription(''); setWhen('now'); setPublishAt(undefined);
    setStep(0);
  };

  const openConnections = () => navigate('/pengaturan/koneksi', { state: { background: location } });
  const detailReady = !!story && !!title.trim() && targets.length > 0;
  const canSend = user.isAdmin && detailReady && !sending && (!scheduling || (!!publishAt && !scheduleInPast));

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 pt-2 text-[13px]">
      <p className="text-[13px] text-muted-foreground">Kirim video yang sudah jadi ke YouTube, TikTok atau Facebook. Akun tujuan diatur di Pengaturan → Koneksi.</p>
      <Steps label="Langkah publish" steps={STEPS} current={step} onStep={i => { if (!sending) setStep(i); }} />

      {step === 0 && (
        storiesError && !stories ? (
          <Failed what="Daftar video" error={storiesError} onRetry={() => void loadStories()} />
        ) : !stories ? (
          <LoadingState label="Memuat video" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] rounded-lg" />)}
          </LoadingState>
        ) : stories.length === 0 ? (
          <Empty title="Belum ada video yang selesai"
            reason="Hanya cerita yang sudah selesai dirender yang bisa dipublish. Buat cerita dulu, lalu kembali ke sini setelah videonya jadi."
            action={<Button size="sm" variant="glass" data-strong="" onClick={() => navigate('/')}><Film /> Buat video</Button>} />
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">Pilih video yang mau dikirim.</p>
            <ul aria-label="Video selesai" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {stories.map(s => (
                <li key={s.id}>
                  <button type="button" onClick={() => pickStory(s)} aria-pressed={s.id === storyId}
                    className={cn('glass-panel flex w-full flex-col overflow-hidden rounded-lg text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60',
                      s.id === storyId && 'ring-2 ring-foreground/50')}>
                    <Poster id={s.id} className="aspect-[4/5]" />
                    <span className="flex flex-col gap-0.5 p-2.5">
                      <span className="truncate text-[13px] font-medium text-foreground">{s.title}</span>
                      {s.video && <span className="text-[11.5px] text-muted-foreground">{formatMb(s.video.bytes)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {step === 1 && story && (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <Panel className="hidden p-0 md:block overflow-hidden">
            <Poster id={story.id} className="aspect-[4/5]" />
            <p className="truncate px-3 py-2 text-[12.5px] text-muted-foreground">{story.title}</p>
          </Panel>
          <Panel className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1">
              <Field label="Judul">
                <input className={inputClass} placeholder="Judul video, mis. Selendang Merah — dongeng 1 menit" value={title} maxLength={100} aria-describedby="pub-title-hint" onChange={e => { setTitle(e.target.value); resetRun(); }} />
              </Field>
              <span id="pub-title-hint" className="text-[11.5px] text-muted-foreground/80">Maks. 100 karakter. YouTube memakai ini sebagai judul; TikTok dan Meta sebagai baris pertama caption.</span>
            </div>
            <Field label="Deskripsi">
              <textarea className={textareaClass} value={description} maxLength={5000} onChange={e => { setDescription(e.target.value); resetRun(); }}
                placeholder="Ceritakan singkat isi videonya, tambahkan hashtag bila perlu." />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Visibilitas</span>
              <Segmented<Visibility> name="Visibilitas" value={visibility} onChange={v => { setVisibility(v); resetRun(); }}
                options={VISIBILITIES.map(v => ({ value: v, label: VISIBILITY_LABEL[v] }))} />
              <span className="text-[11.5px] text-muted-foreground/80">TikTok: selain Publik dikirim sebagai &ldquo;Hanya saya&rdquo;. Meta: Reels selalu tayang di Halaman.</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">Platform tujuan</span>
              {statusError && !statuses ? (
                <Failed compact what="Status platform" error={statusError} onRetry={() => void loadStatuses()} />
              ) : !statuses ? (
                <LoadingState label="Memuat platform" className="flex gap-1.5">
                  {[0, 1].map(i => <Skeleton key={i} className="h-8 w-24 rounded-md" />)}
                </LoadingState>
              ) : connected.length === 0 ? (
                <div className="flex flex-col items-start gap-2 rounded-md border border-dashed px-3 py-3">
                  <p className="text-[13px] text-foreground">Belum ada platform terhubung.</p>
                  <p className="text-[12.5px] text-muted-foreground">Video hanya bisa dikirim ke akun YouTube, TikTok, atau Meta yang sudah dihubungkan.</p>
                  <Button size="sm" variant="glass" data-strong="" onClick={openConnections}><Link2 /> Hubungkan platform</Button>
                </div>
              ) : (
                <div role="group" aria-label="Platform tujuan" className="flex flex-wrap gap-1.5">
                  {connected.map(s => (
                    <Toggle key={s.platform} variant="outline" size="sm" pressed={targets.includes(s.platform)}
                      onPressedChange={on => toggle(s.platform, on)} title={s.accountLabel ? `Sebagai ${s.accountLabel}` : undefined}
                      className="aria-pressed:glass-chosen aria-pressed:text-foreground">
                      {PLATFORM_LABEL[s.platform]}
                    </Toggle>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 border-t pt-3">
              <Button size="sm" variant="ghost" onClick={() => setStep(0)}>Kembali</Button>
              {!title.trim() && <span className="text-[12px] text-muted-foreground">Judul wajib diisi.</span>}
              {title.trim() && connected.length > 0 && targets.length === 0 && <span className="text-[12px] text-muted-foreground">Pilih minimal satu platform.</span>}
              <Button size="sm" variant="glass" data-strong="" className="ml-auto" disabled={!detailReady} onClick={() => setStep(2)}>Lanjut</Button>
            </div>
          </Panel>
        </div>
      )}

      {step === 2 && story && (
        <Panel className="flex flex-col gap-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted-foreground">Video</dt><dd className="truncate">{title.trim()}</dd>
            <dt className="text-muted-foreground">Ke</dt><dd>{joinNames(targets.map(p => PLATFORM_LABEL[p]))}</dd>
            <dt className="text-muted-foreground">Visibilitas</dt><dd>{scheduling ? 'Pribadi sampai jadwal, lalu Publik' : VISIBILITY_LABEL[visibility]}</dd>
          </dl>

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <span className="text-[12px] text-muted-foreground">Waktu</span>
            <Segmented<'now' | 'schedule'> name="Waktu" value={scheduling ? 'schedule' : 'now'} disabled={sending}
              onChange={v => { setWhen(v); resetRun(); }}
              options={[{ value: 'now', label: 'Sekarang' }, { value: 'schedule', label: 'Jadwalkan', disabled: noSchedule.length > 0 }]} />
            {noSchedule.length > 0 && (
              <p className="text-[12px] text-muted-foreground">
                Jadwal hanya bisa untuk YouTube. {joinNames(noSchedule)} langsung tayang saat dikirim; matikan di langkah Detail untuk menjadwalkan.
              </p>
            )}
            {scheduling && (
              <div className="flex flex-col items-start gap-1">
                <DateTimePicker label="Jadwal tayang" value={publishAt} onChange={d => { setPublishAt(d); resetRun(); }} now={now()} disabled={sending} />
                <span className="text-[11.5px] text-muted-foreground/80">YouTube menyimpan video sebagai Pribadi, lalu menayangkannya sebagai Publik pada waktu ini.</span>
                {scheduleInPast && <span role="alert" className="text-[12px] text-destructive">Waktu itu sudah lewat. Pilih waktu di masa depan.</span>}
              </div>
            )}
          </div>

          {ran && (
            <ul aria-label="Hasil publish" className="flex flex-col border-t pt-2">
              {targets.filter(p => outcomes[p]).map(p => {
                const o = outcomes[p]!;
                return (
                  <li key={p} aria-label={PLATFORM_LABEL[p]} className="flex items-start gap-2.5 border-b border-border/60 py-2 text-[13px] last:border-b-0">
                    {o.state === 'sending' ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                      : o.state === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-(--success)" aria-hidden="true" />
                      : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />}
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium">{PLATFORM_LABEL[p]}</span>
                      {o.state === 'sending' && <span className="text-muted-foreground">Mengunggah…</span>}
                      {o.state === 'error' && <span className="text-destructive">{o.message}</span>}
                      {o.state === 'ok' && (
                        <span className="text-muted-foreground">
                          {scheduling && p === 'youtube' && publishAt ? `Terjadwal tayang ${formatWhen(publishAt)}. ` : 'Terkirim. '}
                          {o.result.url
                            ? <a className="inline-flex items-center gap-1 text-foreground underline-offset-3 hover:underline" href={o.result.url} target="_blank" rel="noreferrer">Lihat di {PLATFORM_LABEL[p]} <ExternalLink className="size-3" aria-hidden="true" /></a>
                            : <>Masih diproses {PLATFORM_LABEL[p]}{o.result.externalId ? <span className="font-mono text-[12px]"> · ID {o.result.externalId}</span> : null}</>}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-2 border-t pt-3">
            <Button size="sm" variant="ghost" disabled={sending} onClick={() => setStep(1)}>Kembali</Button>
            {!user.isAdmin && <span className="text-[12px] text-muted-foreground">Hanya admin yang bisa publish.</span>}
            <div className="ml-auto flex items-center gap-2">
              {ran && !sending && pending.length === 0 ? (
                <Button size="sm" variant="glass" data-strong="" onClick={startOver}>Publish video lain</Button>
              ) : ran && !sending ? (
                <Button size="sm" variant="glass" data-strong="" disabled={!canSend} onClick={() => void send()}><RotateCcw /> Kirim ulang yang gagal</Button>
              ) : (
                <Button size="sm" variant="glass" data-strong="" disabled={!canSend} onClick={() => void send()}>{sending ? 'Mengirim…' : 'Publish'}</Button>
              )}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

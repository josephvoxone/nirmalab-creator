import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Film, Image as ImageIcon, RefreshCw, RotateCcw, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Steps } from '../../ui/controls.js';
import { describeError } from '../../ui/states.js';
import { techniqueKey, type Technique } from './compose.js';
import { DEFAULT_NEGATIVE, allPresets, applyPreset, composeShot, type StylePreset } from './presets.js';
import { flowClient, type FlowAccount, type FlowBridge, type FlowFetch, type FlowJob } from './flowClient.js';
import { Composer, type ComposerValue } from './Composer.js';
import { JobList } from './JobList.js';
import { StyleGallery } from './StyleGallery.js';

const POLL_MS = 8_000;
const STEPS = ['Jenis', 'Gaya', 'Prompt', 'Hasil'];
const [KIND, STYLE, PROMPT, RESULTS] = [0, 1, 2, 3];
type Kind = 'video' | 'image';

const KINDS: Array<{ value: Kind; title: string; cost: string; detail: string; icon: typeof Film }> = [
  { value: 'video', title: 'Video 6 detik', cost: '±10 kredit Flow', detail: 'Satu klip Veo dengan native audio. Durasi bisa 4–8 detik.', icon: Film },
  { value: 'image', title: 'Gambar', cost: 'Gratis', detail: 'Satu still image dari Flow, tanpa memakai kredit.', icon: ImageIcon }
];

const EMPTY_COMPOSER: ComposerValue = { subject: '', character: '', style: '', negative: DEFAULT_NEGATIVE.join(', '), picked: [], aspect: '9:16', duration: 6 };

/** One clip or one still: Jenis → Gaya → Prompt → Hasil. Whole stories are made on the home page. */
export function StudioPage(props: { baseUrl: string; fetchImpl: FlowFetch; techniques: Technique[] }) {
  const api = useMemo(() => flowClient(props.baseUrl, props.fetchImpl), [props.baseUrl, props.fetchImpl]);
  const navigate = useNavigate();
  const location = useLocation();
  const [accounts, setAccounts] = useState<FlowAccount[]>([]);
  const [bridge, setBridge] = useState<FlowBridge>({ online: false });
  const [jobs, setJobs] = useState<FlowJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const [step, setStep] = useState(KIND);
  const [kind, setKind] = useState<Kind>('video');
  const [presetId, setPresetId] = useState<string>();
  const [draft, setDraft] = useState<ComposerValue>(EMPTY_COMPOSER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [a, j] = await Promise.all([api.accounts(), api.jobs()]);
      setAccounts(a.accounts);
      setBridge(a.bridge);
      setJobs(j.jobs);
      setLoaded(true);
      setLoadError(undefined);
    } catch (e) {
      setLoadError(e);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const presets = useMemo(() => allPresets(props.techniques), [props.techniques]);
  const preset = presets.find(p => p.id === presetId);
  /** Latest finished Flow render per preset (jobs tagged "preset:<id>"). */
  const ownRenders = useMemo(() => {
    const map = new Map<string, FlowJob>();
    for (const job of jobs) {
      if (job.status !== 'done' || !job.technique?.startsWith('preset:')) continue;
      const id = job.technique.slice('preset:'.length);
      const current = map.get(id);
      if (!current || (job.finishedAtMs ?? 0) > (current.finishedAtMs ?? 0)) map.set(id, job);
    }
    return map;
  }, [jobs]);

  const composed = useMemo(() => composeShot({
    subject: draft.subject,
    character: draft.character,
    picked: draft.picked,
    style: draft.style,
    negative: draft.negative.split(',')
  }), [draft]);

  const go = (next: number) => {
    setStep(next);
    setError(undefined);
  };
  const edit = (patch: Partial<ComposerValue>) => setDraft(d => ({ ...d, ...patch }));

  function chooseKind(value: Kind) {
    setKind(value);
    setNotice(undefined);
    go(STYLE);
  }

  function pickStyle(p: StylePreset) {
    const state = applyPreset(p, props.techniques);
    setDraft({ subject: state.subject, character: state.character, style: state.style, negative: state.negative.join(', '), picked: state.picked, aspect: state.aspect, duration: state.durationSec });
    setPresetId(p.id);
    setNotice(`Gaya "${p.name}" dipakai. Ganti subjek/karakter sesuai ceritamu.`);
    go(PROMPT);
  }

  function noStyle() {
    setPresetId(undefined);
    setDraft(d => ({ ...d, picked: [], style: '', negative: EMPTY_COMPOSER.negative }));
    setNotice(undefined);
    go(PROMPT);
  }

  async function submit(input: Parameters<typeof api.createJob>[0], done: string, fallback: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.createJob(input);
      setNotice(done);
      await refresh();
      return true;
    } catch (e) {
      setError(describeError(e) || fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function renderSample(p: StylePreset) {
    const state = applyPreset(p, props.techniques);
    await submit({
      prompt: composeShot({ subject: state.subject, character: state.character, picked: state.picked, style: state.style, negative: state.negative }),
      aspect: state.aspect,
      durationSec: state.durationSec,
      technique: `preset:${p.id}`
    }, `Render contoh "${p.name}" masuk antrean Flow.`, 'Gagal mengantre render');
  }

  async function queue() {
    if (!composed.trim() || !(draft.subject.trim() || draft.character.trim())) return;
    const ok = await submit({
      prompt: composed,
      aspect: draft.aspect,
      durationSec: draft.duration,
      ...(kind === 'image' ? { kind: 'image' as const } : {}),
      ...(presetId ? { technique: `preset:${presetId}` } : draft.picked[0] ? { technique: techniqueKey(draft.picked[0]) } : {})
    }, kind === 'image' ? 'Gambar masuk antrean (gratis di Flow). Bridge akan mengambilnya.' : 'Klip masuk antrean. Bridge akan mengambilnya dari akun Flow yang siap.', 'Gagal mengantre');
    if (ok) setStep(RESULTS);
  }

  async function retry(job: FlowJob) {
    await submit({
      prompt: job.prompt,
      aspect: job.aspect,
      durationSec: job.durationSec,
      ...(job.kind === 'image' ? { kind: 'image' as const } : {}),
      ...(job.technique ? { technique: job.technique } : {})
    }, 'Job dikirim ulang ke antrean.', 'Gagal mengantre ulang');
  }

  const accountLabel = (id?: string) => accounts.find(a => a.id === id)?.label ?? '—';
  const readyCount = accounts.filter(a => a.status === 'ready').length;
  const credits = accounts.some(a => typeof a.credits === 'number') ? accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 pt-2 text-[13px]">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        {!loaded && loadError === undefined ? (
          <Skeleton aria-label="Memuat status bridge" className="h-4 w-64" />
        ) : loaded ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <i aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', bridge.online ? 'bg-(--success)' : 'bg-destructive')} />
            <span>{bridge.online ? 'Bridge online' : 'Bridge offline · render menunggu Mac'}</span>
            {credits !== undefined && <span>· {credits} kredit</span>}
            <span>· {readyCount}/{accounts.length} akun siap</span>
          </p>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => navigate('/pengaturan/flow', { state: { background: location } })}>
          <Settings2 /> Kelola akun Flow
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {step !== RESULTS && (
            <Button variant="ghost" size="sm" onClick={() => go(RESULTS)}>Lihat hasil ({jobs.length})</Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Muat ulang" title="Muat ulang" onClick={() => void refresh()}><RefreshCw /></Button>
        </div>
      </div>

      {loadError !== undefined && (
        <div role="alert" className="glass-panel flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <b className="text-[13px] font-medium">{loaded ? 'Gagal memperbarui status Flow' : 'Status Flow tidak termuat'}</b>
            <p className="text-[12.5px] text-muted-foreground">{describeError(loadError)}</p>
          </div>
          <Button variant="glass" size="sm" onClick={() => void refresh()}><RotateCcw /> Coba lagi</Button>
        </div>
      )}

      <Steps label="Langkah studio" steps={STEPS} current={step} onStep={go} />

      {error !== undefined && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
      {notice !== undefined && <p role="status" aria-label="Pemberitahuan" className="rounded-md bg-muted/60 px-3 py-2 text-[12.5px] text-muted-foreground">{notice}</p>}

      {step === KIND && (
        <section aria-labelledby="studio-kind-title" className="flex flex-col gap-3">
          <div>
            <h2 id="studio-kind-title" className="text-[14px] font-medium">Mau bikin apa?</h2>
            <p className="text-[12.5px] text-muted-foreground">Studio membuat satu klip atau satu gambar. Untuk cerita utuh beberapa shot, pakai halaman Buat baru.</p>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {KINDS.map(k => (
              <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => chooseKind(k.value)}
                className={cn('glass-panel flex items-start gap-3 rounded-lg p-4 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring/60',
                  kind === k.value && 'glass-chosen ring-1 ring-foreground/40')}>
                <k.icon aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <b className="text-[14px] font-medium">{k.title}</b>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{k.cost}</span>
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">{k.detail}</span>
                </span>
                {kind === k.value && <Check aria-hidden="true" className="size-4 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <Button variant="glass" size="sm" onClick={() => go(STYLE)}>Lanjut <ArrowRight /></Button>
          </div>
        </section>
      )}

      {step === STYLE && (
        <>
          <StyleGallery presets={presets} techniques={props.techniques} presetId={presetId} ownRenders={ownRenders} fileUrl={api.fileUrl}
            busy={busy} onUse={pickStyle} onNone={noStyle} onRenderSample={p => void renderSample(p)} />
          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => go(KIND)}><ArrowLeft /> Kembali</Button>
            <Button variant="glass" size="sm" onClick={() => go(PROMPT)}>Lanjut <ArrowRight /></Button>
          </div>
        </>
      )}

      {step === PROMPT && (
        <>
          <Composer kind={kind} value={draft} onChange={edit} techniques={props.techniques} composed={composed} presetName={preset?.name}
            busy={busy} onQueue={() => void queue()} />
          <div className="flex">
            <Button variant="ghost" size="sm" onClick={() => go(STYLE)}><ArrowLeft /> Kembali</Button>
          </div>
        </>
      )}

      {step === RESULTS && (
        <>
          <JobList jobs={jobs} loaded={loaded} loadFailed={loadError !== undefined} busy={busy} fileUrl={api.fileUrl} accountLabel={accountLabel}
            onRetry={job => void retry(job)} onStart={() => go(KIND)} />
          {jobs.length > 0 && (
            <div className="flex">
              <Button variant="ghost" size="sm" onClick={() => go(PROMPT)}><ArrowLeft /> Ubah prompt</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

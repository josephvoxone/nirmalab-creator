/**
 * Pengaturan › Provider (admin): which engines can make images and video.
 * Google Flow is summarised only (accounts live in Akun Flow); OpenRouter gets its key,
 * a connection test and the default image/video models the engine pickers offer.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, KeyRound, PlugZap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { Choice, inputClass } from '../../ui/controls.js';
import { LoadingState, describeError } from '../../ui/states.js';
import {
  AXCEL_DEFAULT_MODEL, fitsStory, fmtUsd, providersApi, savedKeyText, sortVideoModels,
  type AxcelState, type Balance, type ModelInfo, type Models, type OpenRouterPatch, type OpenRouterState, type Providers
} from '../providers/providersClient.js';

type Api = ReturnType<typeof providersApi>;

function Section(props: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={props.id} className="text-[14px] font-medium text-foreground">{props.title}</h2>
        {props.hint && <p className="text-[12.5px] text-muted-foreground">{props.hint}</p>}
      </div>
      {props.children}
    </section>
  );
}

function Row(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-foreground">{props.title}</span>
        {props.hint && <span className="text-[12px] text-muted-foreground">{props.hint}</span>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">{props.children}</div>
    </div>
  );
}

function Failed(props: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1">{props.what} gagal dimuat. {describeError(props.error)}</span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}>Coba lagi</Button>
    </div>
  );
}

const ErrorLine = (props: { children: ReactNode }) => <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{props.children}</p>;

export const balanceText = (b: Balance) =>
  `Terhubung · terpakai ${fmtUsd(b.usedUsd)} · batas ${b.limitUsd == null ? 'tanpa batas' : fmtUsd(b.limitUsd)} · sisa ${b.remainingUsd == null ? '—' : fmtUsd(b.remainingUsd)}`;

/* ---------- Google Flow (summary only) ---------- */

function FlowSummary(props: { flow?: Providers['flow']; onManage: () => void }) {
  const f = props.flow;
  return (
    <Section id="prov-flow" title="Google Flow" hint="Gratis lewat pool akun Google Flow; video memakai kredit akun, gambar & keyframe tidak.">
      <Row title={f ? `${f.accounts} akun · ${typeof f.credits === 'number' ? `${f.credits} kredit` : 'kredit belum diketahui'} · bridge ${f.online ? 'online' : 'offline'}` : '—'}>
        <Button size="sm" variant="glass" onClick={props.onManage}>Kelola di Akun Flow <ArrowRight /></Button>
      </Row>
    </Section>
  );
}

/* ---------- OpenRouter ---------- */

function KeyForm(props: { label: string; busy: boolean; onSave: (key: string) => Promise<boolean>; autoFocus?: boolean; children?: (submit: ReactNode) => ReactNode }) {
  const [key, setKey] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    if (await props.onSave(k)) setKey('');
  };
  return (
    <form className="flex items-end gap-2" onSubmit={e => void submit(e)}>
      <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted-foreground">{props.label}
        <input className={inputClass} type="password" autoComplete="off" spellCheck={false} autoFocus={props.autoFocus}
          placeholder="sk-or-v1-…" value={key} onChange={e => setKey(e.target.value)} />
      </label>
      <Button type="submit" size="lg" disabled={props.busy || !key.trim()}><KeyRound /> {props.busy ? 'Menyimpan…' : 'Simpan key'}</Button>
    </form>
  );
}

function ModelPicker(props: { label: string; kind: 'image' | 'video'; models: ModelInfo[]; value?: string; disabled: boolean; onChange: (id: string) => void }) {
  const list = props.kind === 'video' ? sortVideoModels(props.models) : [...props.models].sort((a, b) => a.name.localeCompare(b.name));
  const options = list.map(m => ({
    value: m.id, label: m.name,
    hint: props.kind === 'video' && fitsStory(m) ? `${m.priceLabel} · keyframe + audio` : m.priceLabel
  }));
  const known = !!props.value && list.some(m => m.id === props.value);
  return (
    <Choice label={props.label} value={known ? props.value! : ''} options={options} disabled={props.disabled} onChange={props.onChange} className="w-64 max-w-full" />
  );
}

function OpenRouterCard(props: { api: Api; state: OpenRouterState; onState: (s: OpenRouterState) => void }) {
  const { api, state } = props;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [balance, setBalance] = useState<Balance>();
  const [testError, setTestError] = useState('');
  const [models, setModels] = useState<Models>();
  const [modelsError, setModelsError] = useState<unknown>();
  const [modelsTick, setModelsTick] = useState(0);

  useEffect(() => {
    if (!state.configured) return;
    let alive = true;
    setModelsError(undefined);
    api.models().then(m => alive && setModels(m), e => alive && setModelsError(e));
    return () => { alive = false; };
  }, [api, state.configured, modelsTick]);

  const save = async (name: string, patch: OpenRouterPatch): Promise<boolean> => {
    setBusy(name);
    setError('');
    try {
      props.onState(await api.save(patch));
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const saveKey = async (apiKey: string) => {
    const ok = await save('key', { apiKey });
    if (ok) { setReplacing(false); setBalance(undefined); setTestError(''); }
    return ok;
  };
  const removeKey = async () => {
    if (await save('remove', { apiKey: null })) { setRemoving(false); setBalance(undefined); setModels(undefined); }
  };
  const test = async () => {
    setBusy('test');
    setTestError('');
    setBalance(undefined);
    try { setBalance((await api.test()).balance); } catch (e) { setTestError(describeError(e)); } finally { setBusy(undefined); }
  };

  const image = Array.isArray(models?.image) ? models.image : [];
  const video = Array.isArray(models?.video) ? models.video : [];

  return (
    <Section id="prov-openrouter" title="OpenRouter" hint="Bayar per pemakaian dari saldo OpenRouter; banyak model gambar dan video (Veo, Kling, GPT Image, …).">
      {!state.configured ? (
        <KeyForm label="API key OpenRouter" busy={busy === 'key'} onSave={saveKey} />
      ) : (
        <div className="flex flex-col">
          <Row title="API key" hint={savedKeyText(state.keyHint)}>
            <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>Ganti</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving(true)}>Hapus</Button>
          </Row>
          <Row title="Koneksi & saldo" hint="Memanggil OpenRouter dengan key tersimpan.">
            <Button size="sm" variant="glass" disabled={busy === 'test'} onClick={() => void test()}><PlugZap /> {busy === 'test' ? 'Mengetes…' : 'Tes koneksi'}</Button>
          </Row>
        </div>
      )}
      {balance && <p role="status" className="text-[12.5px] text-(--success) tabular-nums">{balanceText(balance)}</p>}
      {testError && <ErrorLine>Tes koneksi gagal: {testError}</ErrorLine>}
      {error && <ErrorLine>{error}</ErrorLine>}

      {state.configured && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium">Model bawaan</h3>
          <p className="text-[12px] text-muted-foreground">Dipakai saat memilih Mesin “OpenRouter” di Buat baru, Studio dan proyek.</p>
          {modelsError !== undefined && !models ? (
            <Failed what="Daftar model" error={modelsError} onRetry={() => setModelsTick(t => t + 1)} />
          ) : !models ? (
            <LoadingState label="Memuat model OpenRouter" className="flex flex-col gap-2 pt-1">
              <Skeleton className="h-9 w-full rounded-md" /><Skeleton className="h-9 w-full rounded-md" />
            </LoadingState>
          ) : image.length === 0 && video.length === 0 ? (
            <div className="glass-panel flex items-center gap-3 rounded-md px-3 py-3 text-[12.5px]">
              <span className="min-w-0 flex-1 text-muted-foreground">Belum ada model dari OpenRouter — daftar model kosong atau sedang diperbarui.</span>
              <Button size="sm" variant="ghost" onClick={() => { setModels(undefined); setModelsTick(t => t + 1); }}>Muat ulang</Button>
            </div>
          ) : (
            <div className="flex flex-col">
              <Row title="Gambar" hint="Lembar karakter, keyframe dan still Studio.">
                <ModelPicker label="Model gambar bawaan" kind="image" models={image} value={state.defaults?.image} disabled={busy === 'image'}
                  onChange={id => void save('image', { defaults: { image: id } })} />
              </Row>
              <Row title="Video" hint="Urut dari termurah. “keyframe + audio” = cocok untuk mode Konsisten dengan narasi.">
                <ModelPicker label="Model video bawaan" kind="video" models={video} value={state.defaults?.video} disabled={busy === 'video'}
                  onChange={id => void save('video', { defaults: { video: id } })} />
              </Row>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={replacing} onOpenChange={o => { if (!o) setReplacing(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ganti API key OpenRouter?</AlertDialogTitle>
            <AlertDialogDescription>Key lama ({savedKeyText(state.keyHint).replace('Tersimpan ', '')}) langsung tidak dipakai lagi. Job yang sedang jalan memakai key baru.</AlertDialogDescription>
          </AlertDialogHeader>
          <KeyForm label="API key baru" busy={busy === 'key'} onSave={saveKey} autoFocus />
          {error && <ErrorLine>{error}</ErrorLine>}
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing} onOpenChange={o => { if (!o) setRemoving(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus API key OpenRouter?</AlertDialogTitle>
            <AlertDialogDescription>Mesin OpenRouter jadi tidak bisa dipilih. Job OpenRouter yang masih antre akan gagal; proyek kembali memakai Google Flow saat dirender ulang.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy === 'remove'} onClick={() => void removeKey()}>Ya, hapus key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}


/* ---------- Axcel (Gold plan, through the Mac bridge) ---------- */

function AxcelTokenForm(props: { busy: boolean; onSave: (token: string) => Promise<boolean> }) {
  const [token, setToken] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) return;
    if (await props.onSave(value)) setToken('');
  };
  return (
    <form className="flex items-end gap-2" onSubmit={e => void submit(e)}>
      <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted-foreground">Token bridge Axcel (dari ~/.config/opencreator/axcel-bridge.env)
        <input className={inputClass} type="password" autoComplete="off" spellCheck={false}
          placeholder="AXCEL_BRIDGE_TOKEN" value={token} onChange={e => setToken(e.target.value)} />
      </label>
      <Button type="submit" size="lg" disabled={props.busy || !token.trim()}><KeyRound /> {props.busy ? 'Menyimpan…' : 'Simpan token'}</Button>
    </form>
  );
}

/**
 * Axcel has no public API: the Mac bridge (`bridge/axcel.mjs`) drives the logged-in Chrome and the
 * server talks to that bridge. So this card only needs the bridge URL + token, and shows which
 * account/plan the bridge is currently using.
 */
function AxcelCard(props: { api: Api; state: AxcelState; onState: (next: AxcelState) => void }) {
  const state = props.state;
  const [busy, setBusy] = useState<'token' | 'test' | undefined>();
  const [error, setError] = useState('');
  const health = state.health;

  const save = async (token: string) => {
    setBusy('token'); setError('');
    try { props.onState(await props.api.saveAxcel({ token })); return true; }
    catch (e) { setError(describeError(e)); return false; }
    finally { setBusy(undefined); }
  };
  const test = async () => {
    setBusy('test'); setError('');
    try {
      const { health: live } = await props.api.testAxcel();
      props.onState({ ...state, health: live ?? null, error: undefined });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(undefined); }
  };

  return (
    <Section id="prov-axcel" title="Axcel (Gold)" hint="Langganan Axcel diakses lewat bridge di Mac yang memakai sesi Chrome kamu. Tanpa biaya per klip; giliran mengikuti batas harian Axcel.">
      {!state.configured ? <AxcelTokenForm busy={busy === 'token'} onSave={save} /> : (
        <div className="flex flex-col">
          <Row title="Token bridge" hint={savedKeyText(state.tokenHint)}>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void props.api.saveAxcel({ token: null }).then(props.onState)}>Hapus</Button>
          </Row>
          <Row title="Koneksi" hint={health?.akun ? `${health.akun} · paket ${health.plan ?? '—'}${health.planAktif ? ' aktif' : ' tidak aktif'}` : state.url}>
            <Button size="sm" variant="glass" disabled={busy === 'test'} onClick={() => void test()}><PlugZap /> {busy === 'test' ? 'Mengetes…' : 'Tes koneksi'}</Button>
          </Row>
          <Row title="Model" hint={`Gambar: ${AXCEL_DEFAULT_MODEL.image} · Video: ${AXCEL_DEFAULT_MODEL.video}${health?.refMedia ? ' · referensi video/audio tersedia' : ''}`}>{null}</Row>
        </div>
      )}
      {state.error && <ErrorLine>Bridge Axcel: {state.error}</ErrorLine>}
      {error && <ErrorLine>{error}</ErrorLine>}
    </Section>
  );
}

/* ---------- the tab ---------- */

export function ProviderPanel(props: { onOpenFlow: () => void }) {
  const { fetchImpl } = useSession();
  const api = useMemo(() => providersApi(fetchImpl), [fetchImpl]);
  const [data, setData] = useState<Providers>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let alive = true;
    setError(undefined);
    api.get().then(d => alive && setData(d), e => alive && setError(e));
    return () => { alive = false; };
  }, [api, tick]);

  return (
    <>
      <p className={cn('text-[12.5px] text-muted-foreground')}>Atur mesin pembuat gambar & video. Mesinnya dipilih saat mulai membuat (Buat baru, Studio, Breakdown).</p>
      {error !== undefined && !data ? <Failed what="Pengaturan provider" error={error} onRetry={reload} />
        : !data ? (
          <LoadingState label="Memuat provider" className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full rounded-md" /><Skeleton className="h-9 w-full rounded-md" /><Skeleton className="h-9 w-full rounded-md" />
          </LoadingState>
        ) : (
          <>
            <FlowSummary flow={data.flow} onManage={props.onOpenFlow} />
            <OpenRouterCard api={api} state={data.openrouter ?? { configured: false, defaults: {} }} onState={openrouter => setData(d => (d ? { ...d, openrouter } : d))} />
            <AxcelCard api={api} state={data.axcel ?? { configured: false, url: 'http://127.0.0.1:8899' }} onState={axcel => setData(d => (d ? { ...d, axcel } : d))} />
          </>
        )}
    </>
  );
}

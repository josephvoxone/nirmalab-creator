/**
 * Dubbing tab: ElevenLabs voice per shot, per scene or for the whole project. Costs are never a surprise: every
 * dub first asks the server for the estimate (free), shows it, and only sends "confirmCredits" after the user
 * agrees. Shots whose text and voice did not change are never rendered (or charged) again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Check, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Choice, Segmented, inputClass } from '../../ui/controls.js';
import { EmptyState, ErrorState, LoadingState, describeError } from '../../ui/states.js';
import { dubApi, fmtCredits, STATUS_TEXT, type DubPlan, type DubScope, type DubShot, type DubState, type Voice } from './dubClient.js';
import { useProject } from './useProject.js';

const TONE: Record<DubShot['status'], string> = { none: 'text-muted-foreground', queued: 'text-muted-foreground', running: 'text-foreground', done: 'text-(--success)', stale: 'text-foreground', failed: 'text-destructive' };
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2].map(v => ({ value: String(v), label: `${v}×` }));

type Pending = { scope: DubScope; plan: DubPlan; force: boolean; label: string };

export function DubTab() {
  const p = useProject();
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => dubApi(fetchImpl), [fetchImpl]);
  const canEdit = user.isAdmin;
  const [dub, setDub] = useState<DubState>();
  const [loadError, setLoadError] = useState<unknown>();
  const [voices, setVoices] = useState<Voice[]>();
  const [voiceError, setVoiceError] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [tick, setTick] = useState(0);
  const wasActive = useRef(false);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let alive = true;
    api.state(p.id).then(s => { if (alive) { setDub(s); setLoadError(undefined); } }, e => alive && setLoadError(e));
    return () => { alive = false; };
  }, [api, p.id, tick]);

  // While shots are queued or running the server is working: poll, and when it ends tell the project (the video is now stale).
  const active = dub?.totals.active ?? 0;
  useEffect(() => {
    if (active > 0) { wasActive.current = true; const t = setTimeout(reload, 2000); return () => clearTimeout(t); }
    if (wasActive.current) { wasActive.current = false; p.reload(); }
    return undefined;
  }, [active, tick, reload, p]);

  useEffect(() => {
    if (!dub?.configured || voices) return;
    let alive = true;
    api.voices().then(v => alive && setVoices(v), e => alive && setVoiceError(describeError(e)));
    return () => { alive = false; };
  }, [api, dub?.configured, voices]);

  const run = async (name: string, fn: () => Promise<DubState | undefined>) => {
    setBusy(name); setError('');
    try { const s = await fn(); if (s) setDub(s); } catch (e) { setError(describeError(e)); } finally { setBusy(undefined); }
  };

  const ask = (scope: DubScope, label: string, force = false) => run(`plan:${label}`, async () => {
    const plan = await api.plan(p.id, scope, force);
    if (!plan.shotIds.length) { setPending(undefined); setError('Tidak ada yang perlu di-dub: semuanya sudah terbaru.'); return undefined; }
    setPending({ scope, plan, force, label });
    return undefined;
  });
  const confirm = () => pending && run('render', async () => {
    const s = await api.render(p.id, pending.scope, pending.plan.credits, pending.force);
    setPending(undefined);
    return s;
  });

  if (loadError !== undefined && !dub) return <ErrorState title="Dubbing gagal dimuat" error={loadError} onRetry={reload} />;
  if (!dub) return <LoadingState label="Memuat dubbing" className="flex flex-col gap-2"><Skeleton className="h-10 w-full rounded-md" /><Skeleton className="h-24 w-full rounded-md" /></LoadingState>;
  if (!dub.shots.length) return <EmptyState title="Belum ada shot" reason="Buat storyboard dulu; dubbing mengikuti narasi tiap shot." />;

  const scenes = (p.board?.scenes ?? []).map(sc => ({ id: sc.id, title: sc.title, shots: dub.shots.filter(s => s.sceneId === sc.id) })).filter(g => g.shots.length);
  const loose = dub.shots.filter(s => !s.sceneId || !scenes.some(g => g.id === s.sceneId));
  const groups = loose.length ? [...scenes, { id: '', title: 'Lainnya', shots: loose }] : scenes;
  const voiceOptions = [...(voices ?? []).map(v => ({ value: v.id, label: v.name, hint: [v.gender, v.age, v.category].filter(Boolean).join(' · ') || undefined })),
    ...(dub.settings.voiceId && !(voices ?? []).some(v => v.id === dub.settings.voiceId) ? [{ value: dub.settings.voiceId, label: dub.settings.voiceId, hint: undefined }] : [])];
  const t = dub.totals;
  const lock = !canEdit;

  const shotRow = (s: DubShot) => {
    const isEditing = editing === s.shotId;
    const working = s.status === 'queued' || s.status === 'running';
    return (
      <li key={s.shotId} aria-label={`Shot ${s.shotId}`} className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-muted-foreground">{s.shotId}</span>
          <Badge variant="secondary" className={cn('h-4.5 px-1.5 text-[11px] font-normal', TONE[s.status])}>{s.skipped ? 'Tanpa narasi' : STATUS_TEXT[s.status]}</Badge>
          {s.textSource === 'override' && <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px] font-normal text-muted-foreground">teks khusus</Badge>}
          {s.seconds !== undefined && <span className="text-[12px] text-muted-foreground tabular-nums">{fmtCredits(s.seconds)} dtk</span>}
          <span className="ml-auto flex items-center gap-1">
            {!lock && !isEditing && <Button size="sm" variant="ghost" aria-label={`Ubah teks ${s.shotId}`} onClick={() => { setEditing(s.shotId); setDraft(s.text); }}><Pencil /></Button>}
            {!lock && !s.skipped && <Button size="sm" variant="glass" disabled={working || busy !== undefined || !dub.configured} onClick={() => void ask({ kind: 'shots', shotIds: [s.shotId] }, s.shotId, s.status === 'done')}>
              {s.status === 'done' ? <><RefreshCw /> Dub ulang</> : <><AudioLines /> Dub</>}
            </Button>}
            {!lock && (s.status === 'done' || s.status === 'stale') && <Button size="sm" variant="ghost" aria-label={`Hapus dub ${s.shotId}`} disabled={busy !== undefined} onClick={() => void run(`rm:${s.shotId}`, () => api.removeShot(p.id, s.shotId))}><Trash2 /></Button>}
          </span>
        </div>
        {isEditing ? (
          <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); void run(`text:${s.shotId}`, () => api.setShot(p.id, s.shotId, { text: draft.trim() || null })).then(() => setEditing(undefined)); }}>
            <input className={inputClass} aria-label={`Teks dubbing ${s.shotId}`} placeholder="Teks yang diucapkan (kosong = pakai narasi shot)" value={draft} onChange={e => setDraft(e.target.value)} autoFocus />
            <Button type="submit" size="sm" variant="glass" aria-label="Simpan teks"><Check /></Button>
            <Button type="button" size="sm" variant="ghost" aria-label="Batal ubah teks" onClick={() => setEditing(undefined)}><X /></Button>
          </form>
        ) : <p className={cn('text-[13px] leading-snug', s.skipped ? 'text-muted-foreground italic' : 'text-foreground')}>{s.skipped ? 'Shot ini tidak punya narasi.' : s.text}</p>}
        {s.tooLong && <p role="alert" className="text-[12px] text-destructive">Teks terlalu panjang untuk satu shot.</p>}
        {s.status === 'failed' && s.error && <p role="alert" className="text-[12px] text-destructive">{s.error}</p>}
        {(s.status === 'done' || s.status === 'stale') && s.audio && <audio controls preload="none" className="h-8 w-full max-w-sm" aria-label={`Putar dub ${s.shotId}`} src={api.audioUrl(p.id, s.shotId, s.audio)} />}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {!dub.configured && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-[12.5px] text-muted-foreground">Belum ada API key ElevenLabs. Admin mengisinya di Pengaturan › Provider › ElevenLabs.</p>
      )}
      <section aria-label="Pengaturan suara" className="flex flex-wrap items-end gap-3">
        <Choice label="Suara" showLabel value={dub.settings.voiceId ?? ''} options={voiceOptions} placeholder={voices ? 'Pilih suara…' : 'Memuat suara…'} disabled={lock || !dub.configured || busy !== undefined}
          onChange={voiceId => void run('voice', () => api.settings(p.id, { voiceId }))} className="w-52" />
        <Choice label="Model" showLabel value={dub.settings.modelId} options={dub.models.map(m => ({ value: m.id, label: m.label }))} disabled={lock || busy !== undefined}
          onChange={modelId => void run('model', () => api.settings(p.id, { modelId }))} className="w-64 max-w-full" />
        <Choice label="Kecepatan" showLabel value={String(dub.settings.voice.speed)} options={SPEEDS} disabled={lock || busy !== undefined}
          onChange={v => void run('speed', () => api.settings(p.id, { voice: { speed: Number(v) } }))} className="w-24" />
        <div className="flex flex-col gap-1 text-[12px] text-muted-foreground">Suara asli klip
          <Segmented name="Suara asli klip" value={dub.settings.keepAmbient ? 'ambient' : 'mute'} disabled={lock || busy !== undefined}
            options={[{ value: 'ambient', label: 'Diredam', hint: 'Suasana klip tetap terdengar pelan' }, { value: 'mute', label: 'Dimatikan' }]}
            onChange={v => void run('ambient', () => api.settings(p.id, { keepAmbient: v === 'ambient' }))} />
        </div>
      </section>
      {voiceError && <p role="alert" className="text-[12px] text-destructive">Daftar suara gagal dimuat: {voiceError}</p>}

      <section aria-label="Ringkasan" className="flex flex-wrap items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
        <p className="text-[13px] text-foreground tabular-nums">{t.done}/{t.dubbable} shot sudah di-dub{t.stale ? ` · ${t.stale} perlu diulang` : ''}{t.failed ? ` · ${t.failed} gagal` : ''} · {t.chars.toLocaleString('id-ID')} karakter</p>
        {t.active > 0 && <p role="status" className="text-[12.5px] text-muted-foreground tabular-nums">{t.active} shot sedang diproses…</p>}
        <span className="ml-auto flex items-center gap-2">
          {t.active > 0 && !lock && <Button size="sm" variant="ghost" disabled={busy === 'cancel'} onClick={() => void run('cancel', () => api.cancel(p.id))}>Batalkan antrean</Button>}
          {!lock && <Button size="sm" variant="glass" data-strong="" disabled={busy !== undefined || !dub.configured || !dub.settings.voiceId} onClick={() => void ask({ kind: 'all' }, 'semua')}><AudioLines /> Dub semua yang belum</Button>}
        </span>
      </section>
      {p.story?.videoStale && t.done > 0 && <p role="status" className="text-[12.5px] text-muted-foreground">Dubbing berubah. Rakit ulang video di tab Hasil agar suaranya ikut.</p>}

      {pending && (
        <div role="alertdialog" aria-label="Konfirmasi biaya dubbing" className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
          <p className="min-w-0 flex-1 text-[13px] text-foreground tabular-nums">
            Dub {pending.label === 'semua' ? 'semua yang belum' : pending.label}: <strong>{pending.plan.shotIds.length} shot</strong>, {pending.plan.chars.toLocaleString('id-ID')} karakter, memakai <strong>±{fmtCredits(pending.plan.credits)} kredit</strong> ElevenLabs.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setPending(undefined)}>Batal</Button>
          <Button size="sm" variant="glass" data-strong="" disabled={busy === 'render'} onClick={() => void confirm()}>{busy === 'render' ? 'Memulai…' : 'Lanjut dub'}</Button>
        </div>
      )}
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      {groups.map(g => {
        const todo = g.shots.filter(s => !s.skipped && s.status !== 'done');
        return (
          <section key={g.id || 'loose'} aria-label={`Scene ${g.title}`} className="flex flex-col">
            <div className="flex items-center gap-2 border-b pb-1.5">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{g.title}</h3>
              {!lock && g.id && todo.length > 0 && <Button size="sm" variant="ghost" disabled={busy !== undefined || !dub.configured || !dub.settings.voiceId} onClick={() => void ask({ kind: 'scene', sceneId: g.id }, `scene “${g.title}”`)}><AudioLines /> Dub scene ini</Button>}
            </div>
            <ul>{g.shots.map(shotRow)}</ul>
          </section>
        );
      })}
    </div>
  );
}

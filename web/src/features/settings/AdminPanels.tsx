/**
 * System-admin panels of Pengaturan (audit 06 §D.6, T8): Penyimpanan (bytes per owner, orphaned projects), the removal dialog and the
 * per-user "Batas & pemakaian" dialog. Everything here is numbers and metadata: a project's title appears ONLY for an orphan
 * (a project without a living owner) — never for one that belongs to somebody.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { formatBytes } from '../../shell/Quota.js';
import { Choice, inputClass } from '../../ui/controls.js';
import { describeError } from '../../ui/states.js';
import { errorText, formatDate, type AdminProjects, type LimitKind, type LimitsView, type Member, type Orphan, type settingsApi, type UserLimits } from './settingsClient.js';

type Api = ReturnType<typeof settingsApi>;

function Section(props: { id: string; title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={props.id} className="text-[14px] font-medium text-foreground">{props.title}</h2>
          {props.hint && <p className="text-[12.5px] text-muted-foreground">{props.hint}</p>}
        </div>
        {props.actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{props.actions}</div>}
      </div>
      {props.children}
    </section>
  );
}

function Failed(props: { error: unknown; onRetry: () => void; what: string }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1">{props.what} gagal dimuat. {describeError(props.error)}</span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}>Coba lagi</Button>
    </div>
  );
}

const Notice = (props: { children: ReactNode; tone?: 'ok' }) => props.tone === 'ok'
  ? <p role="status" className="text-[12.5px] text-(--success)">{props.children}</p>
  : <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{props.children}</p>;

function Loading(props: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={props.label} className="flex flex-col gap-2">
      {Array.from({ length: props.rows ?? 3 }, (_, i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(undefined);
    fn().then(d => alive && setData(d), e => alive && setError(e));
    return () => { alive = false; };
  }, [fn, tick]);
  return { data, error, reload: useCallback(() => setTick(t => t + 1), []), setData };
}

const number = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n);

/* ---------- Anggota: removal dialog ---------- */

/** What removing a member does, in plain words (audit D9: projects stay, suspend is the softer first step). */
export function RemoveMemberDialog(props: { member: Member | undefined; busy: boolean; onCancel: () => void; onConfirm: (m: Member) => void }) {
  const { member } = props;
  return (
    <AlertDialog open={!!member} onOpenChange={open => { if (!open) props.onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keluarkan {member?.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Akunnya dihapus dan dia langsung keluar dari semua perangkat. Token MCP dan koneksi publish miliknya dicabut.
            Proyeknya tidak dihapus: semuanya menjadi proyek yatim yang bisa kamu pindahkan ke pengguna lain atau hapus di Penyimpanan.
            Kalau hanya ingin menghentikan aksesnya sementara, pakai Tangguhkan — datanya utuh dan bisa diaktifkan lagi.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Batal</AlertDialogCancel>
          <AlertDialogAction size="sm" variant="destructive" disabled={props.busy} onClick={() => { if (member) props.onConfirm(member); }}>Ya, keluarkan</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ---------- Anggota: Batas & pemakaian ---------- */

type Field = 'perDay' | 'per30d' | 'perRender';
const KINDS: Array<{ kind: LimitKind; title: string; unit: string; fields: Array<{ field: Field; label: string }> }> = [
  { kind: 'flowCredits', title: 'Flow (kredit)', unit: 'kredit', fields: [{ field: 'perDay', label: 'Per hari' }, { field: 'per30d', label: 'Per 30 hari' }] },
  { kind: 'openrouterUsd', title: 'OpenRouter (USD)', unit: 'USD', fields: [{ field: 'perDay', label: 'Per hari' }, { field: 'per30d', label: 'Per 30 hari' }] },
  { kind: 'elevenChars', title: 'ElevenLabs (karakter)', unit: 'karakter', fields: [{ field: 'perDay', label: 'Per hari' }, { field: 'per30d', label: 'Per 30 hari' }, { field: 'perRender', label: 'Per render' }] },
  { kind: 'genCalls', title: 'Generate gratis (kali)', unit: 'kali', fields: [{ field: 'perDay', label: 'Per hari' }, { field: 'per30d', label: 'Per 30 hari' }] }
];
const SHOWN = new Set<LimitKind>(KINDS.map(k => k.kind));

type Draft = Record<string, string>;
const keyOf = (kind: LimitKind, field: Field) => `${kind}.${field}`;
const textOf = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : '');

function draftFrom(view: LimitsView): Draft {
  const out: Draft = {};
  for (const { kind, fields } of KINDS) for (const { field } of fields) out[keyOf(kind, field)] = textOf(view.effective[kind]?.[field]);
  return out;
}

/** Blank = no limit (null); otherwise a number >= 0 ("5,5" and "5.5" both mean five and a half). */
function parseField(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && /^[0-9]*[.,]?[0-9]*$/.test(t) ? n : undefined;
}

export function LimitsDialog(props: { api: Api; member: Member | undefined; onClose: () => void }) {
  const { api, member } = props;
  const fn = useCallback(() => (member ? api.userLimits(member.id) : Promise.resolve(undefined)), [api, member]);
  const { data: view, error, reload, setData } = useLoad(fn);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (view) setDraft(draftFrom(view)); }, [view]);
  useEffect(() => { setSaved(false); setProblem(''); }, [member]);
  useEffect(() => { if (!member) setData(undefined); }, [member, setData]);

  const save = async (limits: UserLimits | undefined) => {
    if (!member || !view) return;
    setProblem(''); setSaved(false);
    let body: UserLimits = {};
    if (limits) body = limits;
    else {
      const initial = draftFrom(view);
      // kinds this screen has no inputs for (llmTurns) stay exactly as they are
      for (const [kind, value] of Object.entries(view.limits)) if (!SHOWN.has(kind as LimitKind)) body[kind as LimitKind] = value;
      for (const { kind, fields } of KINDS) {
        const touched = view.limits[kind] !== undefined || fields.some(f => (draft[keyOf(kind, f.field)] ?? '') !== initial[keyOf(kind, f.field)]);
        if (!touched) continue;
        const entry: Record<string, number | null> = {};
        for (const { field } of fields) {
          const parsed = parseField(draft[keyOf(kind, field)] ?? '');
          if (parsed === undefined) { setProblem('Isi dengan angka 0 atau lebih, atau kosongkan untuk tanpa batas.'); return; }
          entry[field] = parsed;
        }
        body[kind] = entry;
      }
    }
    setSaving(true);
    try { setData(await api.setUserLimits(member.id, body)); setSaved(true); } catch (e) { setProblem(errorText(e)); } finally { setSaving(false); }
  };

  const noUsage = view ? KINDS.every(k => (view.usage[k.kind]?.d30 ?? 0) === 0 && (view.usage[k.kind]?.day ?? 0) === 0) : false;
  return (
    <Dialog open={!!member} onOpenChange={open => { if (!open) props.onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Batas &amp; pemakaian — {member?.email}</DialogTitle>
          <DialogDescription>Kosong berarti tanpa batas. Perubahan berlaku untuk pemakaian berikutnya; yang sedang berjalan tidak dibatalkan.</DialogDescription>
        </DialogHeader>
        {error && !view ? <Failed what="Batas" error={error} onRetry={reload} />
          : !view ? <Loading label="Memuat batas pengguna" rows={4} />
          : (
            <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
              {noUsage && <p className="text-[12.5px] text-muted-foreground">Belum ada pemakaian dari pengguna ini.</p>}
              {KINDS.map(({ kind, title, unit, fields }) => {
                const usage = view.usage[kind];
                const overridden = view.limits[kind] !== undefined;
                const dayLimit = parseField(draft[keyOf(kind, 'perDay')] ?? '');
                const monthLimit = parseField(draft[keyOf(kind, 'per30d')] ?? '');
                const tooLow = [
                  typeof dayLimit === 'number' && usage && dayLimit < usage.day ? `Batas harian lebih kecil dari pemakaian hari ini (${number(usage.day)}).` : '',
                  typeof monthLimit === 'number' && usage && monthLimit < usage.d30 ? `Batas 30 hari lebih kecil dari pemakaian 30 hari (${number(usage.d30)}).` : ''
                ].filter(Boolean);
                return (
                  <div key={kind} role="group" aria-label={title} className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium">{title}</span>
                      {!overridden && <Badge variant="secondary">Bawaan</Badge>}
                      <span className="ml-auto text-[12px] text-muted-foreground">
                        Terpakai: hari ini {number(usage?.day ?? 0)} · 30 hari {number(usage?.d30 ?? 0)} {unit}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {fields.map(({ field, label }) => {
                        const id = `lim-${kind}-${field}`;
                        return (
                          <label key={field} htmlFor={id} className="flex min-w-28 flex-1 flex-col gap-1 text-[12px] text-muted-foreground">
                            {label}
                            <input id={id} className={inputClass} inputMode="decimal" autoComplete="off" placeholder="Tanpa batas" value={draft[keyOf(kind, field)] ?? ''}
                              onChange={e => { setDraft(d => ({ ...d, [keyOf(kind, field)]: e.target.value })); setSaved(false); }} />
                          </label>
                        );
                      })}
                    </div>
                    {tooLow.map(t => <p key={t} className="text-[12px] text-(--warning,theme(colors.amber.500))">{t}</p>)}
                  </div>
                );
              })}
            </div>
          )}
        {problem && <Notice>{problem}</Notice>}
        {saved && <Notice tone="ok">Batas disimpan.</Notice>}
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={!view || saving} onClick={() => void save({})}>Kembalikan ke bawaan</Button>
          <Button size="sm" variant="ghost" onClick={props.onClose}>Tutup</Button>
          <Button size="sm" disabled={!view || saving} onClick={() => void save(undefined)}>Simpan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- Penyimpanan ---------- */

function MoveDialog(props: { orphan: Orphan | undefined; owners: AdminProjects['owners']; api: Api; onClose: () => void; onMoved: (id: string) => void }) {
  const { orphan, api } = props;
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => { setTo(''); setProblem(''); }, [orphan]);
  const options = props.owners.filter(o => !o.suspendedAt).map(o => ({ value: o.userId, label: o.email }));
  const go = async () => {
    if (!orphan || !to) return;
    setBusy(true); setProblem('');
    try { await api.transferProject(orphan.id, to); props.onMoved(orphan.id); } catch (e) { setProblem(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!orphan} onOpenChange={open => { if (!open) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pindahkan proyek yatim</DialogTitle>
          <DialogDescription>
            “{orphan?.title}” akan menjadi milik pengguna yang kamu pilih, lengkap dengan isinya. Pemilik sebelumnya dicatat di riwayat tindakan admin.
          </DialogDescription>
        </DialogHeader>
        <Choice label="Pengguna tujuan" showLabel value={to} options={options} onChange={setTo} placeholder="Pilih pengguna" className="w-full" />
        {problem && <Notice>{problem}</Notice>}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>Batal</Button>
          <Button size="sm" disabled={!to || busy} onClick={() => void go()}>Pindahkan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteOrphanDialog(props: { orphan: Orphan | undefined; api: Api; onClose: () => void; onDeleted: (id: string) => void }) {
  const { orphan, api } = props;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => { setTyped(''); setProblem(''); }, [orphan]);
  const go = async () => {
    if (!orphan) return;
    setBusy(true); setProblem('');
    try { await api.deleteProject(orphan.id, typed); props.onDeleted(orphan.id); } catch (e) { setProblem(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <AlertDialog open={!!orphan} onOpenChange={open => { if (!open) props.onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Hapus proyek yatim?</AlertDialogTitle>
          <AlertDialogDescription>
            “{orphan?.title}” ({orphan ? formatBytes(orphan.bytes) : ''}) beserta semua isinya dihapus permanen dan tidak bisa dibatalkan. Tindakan ini tercatat di riwayat admin.
            Ketik judul proyek untuk melanjutkan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <input className={inputClass} aria-label="Judul proyek untuk konfirmasi" placeholder="Ketik judul proyek" autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} />
        {problem && <Notice>{problem}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Batal</AlertDialogCancel>
          {/* a plain button, not AlertDialogAction: a refusal must keep the dialog open to show why */}
          <Button size="sm" variant="destructive" disabled={busy || !orphan || typed !== orphan.title} onClick={() => void go()}>Hapus permanen</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function StorageTab(props: { api: Api }) {
  const { api } = props;
  const fn = useCallback(() => api.adminProjects(), [api]);
  const { data, error, reload, setData } = useLoad(fn);
  const [moving, setMoving] = useState<Orphan>();
  const [deleting, setDeleting] = useState<Orphan>();
  const [cleaning, setCleaning] = useState(false);
  const [cleanup, setCleanup] = useState('');
  const [cleanupError, setCleanupError] = useState('');

  const clean = async () => {
    setCleaning(true); setCleanup(''); setCleanupError('');
    try { const r = await api.cleanupStorage(); setCleanup(`Selesai: membebaskan ${formatBytes(r.freedBytes)} (${r.removed} berkas dihapus, ${r.linked} digabung).`); reload(); } catch (e) { setCleanupError(errorText(e)); } finally { setCleaning(false); }
  };
  const drop = (id: string) => data && setData({ ...data, orphans: data.orphans.filter(o => o.id !== id), totals: { ...data.totals, orphans: data.totals.orphans - 1 } });

  if (error && !data) return <Section id="set-storage-load" title="Penyimpanan"><Failed what="Penyimpanan" error={error} onRetry={reload} /></Section>;
  if (!data) return <Section id="set-storage-load" title="Penyimpanan"><Loading label="Memuat penyimpanan" /></Section>;
  return (
    <>
      <Section id="set-storage-owners" title="Pemakaian per pengguna" hint="Jumlah proyek dan ukuran foldernya. Judul dan isi proyek orang lain tidak ditampilkan di sini."
        actions={<Button size="sm" variant="glass" disabled={cleaning} onClick={() => void clean()}>Bersihkan</Button>}>
        {cleanup && <Notice tone="ok">{cleanup}</Notice>}
        {cleanupError && <Notice>{cleanupError}</Notice>}
        <table aria-label="Pemakaian per pengguna" className="w-full text-left text-[13px]">
          <thead className="text-[12px] text-muted-foreground"><tr><th className="py-1 font-normal">Pengguna</th><th className="py-1 font-normal">Proyek</th><th className="py-1 text-right font-normal">Ukuran</th></tr></thead>
          <tbody>
            {data.owners.map(o => (
              <tr key={o.userId} className="border-t border-border/60">
                <td className="py-2">{o.email}{o.suspendedAt && <Badge variant="secondary" className="ml-2">Ditangguhkan</Badge>}</td>
                <td className="py-2">{number(o.projects)}</td>
                <td className="py-2 text-right text-muted-foreground">{formatBytes(o.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section id="set-storage-orphans" title="Proyek yatim" hint="Proyek yang pemiliknya sudah dikeluarkan. Hanya di sini judulnya terlihat, supaya kamu bisa memutuskan: pindahkan ke pengguna lain atau hapus.">
        {data.orphans.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground"><span className="text-foreground">Tidak ada proyek yatim.</span> Proyek menjadi yatim saat pemiliknya dikeluarkan dari workspace.</p>
        ) : (
          <ul aria-label="Proyek yatim" className="flex flex-col">
            {data.orphans.map(o => (
              <li key={o.id} aria-label={o.title || o.id} className="flex flex-wrap items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{o.title || '(tanpa judul)'}</span>
                  <span className="truncate text-[12px] text-muted-foreground">
                    {o.id} · pemilik lama {o.ownerEmail ?? 'tidak diketahui'} · {formatBytes(o.bytes)} · dibuat {formatDate(new Date(o.createdAtMs).toISOString())}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setMoving(o)}>Pindahkan ke…</Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(o)}>Hapus</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <MoveDialog orphan={moving} owners={data.owners} api={api} onClose={() => setMoving(undefined)} onMoved={id => { setMoving(undefined); reload(); drop(id); }} />
      <DeleteOrphanDialog orphan={deleting} api={api} onClose={() => setDeleting(undefined)} onDeleted={id => { setDeleting(undefined); drop(id); reload(); }} />
    </>
  );
}

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Gauge, Link2, LogOut, Server, Settings2, UserRound, Users } from 'lucide-react';
import { ConnectionsPanel } from './ConnectionsPanel.js';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { usePrefs, type Prefs } from '../../lib/prefs.js';
import { describeError } from '../../ui/states.js';
import {
  ACCOUNT_STATUS, errorText, formatDate, inviteLink, inviteState, relativeTime, settingsApi, totalCredits,
  type BridgeStatus, type CreatedInvite, type FlowAccount, type Invite, type Member, type Rotation, type Usage
} from './settingsClient.js';

type Api = ReturnType<typeof settingsApi>;
export type SettingsTab = 'umum' | 'akun' | 'anggota' | 'penggunaan' | 'flow' | 'koneksi';

export const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Users; admin?: boolean }> = [
  { id: 'umum', label: 'Umum', icon: Settings2 },
  { id: 'akun', label: 'Akun', icon: UserRound },
  { id: 'anggota', label: 'Anggota', icon: Users, admin: true },
  { id: 'penggunaan', label: 'Penggunaan', icon: Gauge, admin: true },
  { id: 'flow', label: 'Akun Flow', icon: Server, admin: true },
  { id: 'koneksi', label: 'Koneksi', icon: Link2 }
];

const field = 'h-8 w-full rounded-md border bg-(--field) px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring';
const label = 'flex flex-col gap-1 text-[12px] text-muted-foreground';

/* ---------- building blocks ---------- */

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

/** ChatGPT's settings row: what it is on the left, the control on the right, a hairline between rows. */
function Row(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-foreground">{props.title}</span>
        {props.hint && <span className="text-[12px] text-muted-foreground">{props.hint}</span>}
      </div>
      <div className="ml-auto shrink-0">{props.children}</div>
    </div>
  );
}

function Segmented<T extends string>(props: { name: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={props.name} className="glass-well inline-flex rounded-md bg-muted p-0.5">
      {props.options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={props.value === o.value} onClick={() => props.onChange(o.value)}
          className={cn('h-6.5 rounded-[6px] px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground',
            props.value === o.value && 'glass-chosen text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Rows(props: { count: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {Array.from({ length: props.count }, (_, i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
    </div>
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

function Notice(props: { children: ReactNode; tone?: 'error' | 'ok' }) {
  return props.tone === 'ok'
    ? <p role="status" className="text-[12.5px] text-(--success)">{props.children}</p>
    : <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{props.children}</p>;
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

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button type="button" size="sm" variant="glass" onClick={() => {
      void navigator.clipboard?.writeText(props.text).then(() => setCopied(true), () => undefined);
    }}>
      {copied ? <Check /> : <Copy />} {copied ? 'Tersalin' : 'Salin'}
    </Button>
  );
}

const tone = (t: string) => t === 'done' || t === 'ok' ? 'text-(--success)' : t === 'failed' || t === 'error' ? 'text-destructive' : 'text-muted-foreground';

/* ---------- Umum ---------- */

function GeneralTab() {
  const [prefs, set] = usePrefs();
  return (
    <Section id="set-general" title="Umum" hint="Bawaan untuk prompt baru. Tersimpan di browser ini.">
      <div className="flex flex-col">
        <Row title="Mode bawaan" hint="Konsisten: karakter & keyframe dulu. Cepat: langsung video.">
          <Segmented<Prefs['mode']> name="Mode bawaan" value={prefs.mode} onChange={mode => set({ mode })} options={[{ value: 'konsisten', label: 'Konsisten' }, { value: 'cepat', label: 'Cepat' }]} />
        </Row>
        <Row title="Rasio bawaan">
          <Segmented<Prefs['aspect']> name="Rasio bawaan" value={prefs.aspect} onChange={aspect => set({ aspect })} options={[{ value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }]} />
        </Row>
        <Row title="Jumlah shot bawaan" hint="Satu shot ±6 detik.">
          <Segmented<Prefs['shots']> name="Jumlah shot bawaan" value={prefs.shots} onChange={shots => set({ shots })} options={(['4', '6', '8', '10', '12'] as const).map(v => ({ value: v, label: v }))} />
        </Row>
        <Row title="Kepadatan tampilan">
          <Segmented<Prefs['density']> name="Kepadatan tampilan" value={prefs.density} onChange={density => set({ density })} options={[{ value: 'ringkas', label: 'Ringkas' }, { value: 'nyaman', label: 'Nyaman' }]} />
        </Row>
        <Row title="Bahasa antarmuka"><span className="text-[13px] text-muted-foreground">Indonesia</span></Row>
      </div>
    </Section>
  );
}

/* ---------- Akun ---------- */

function PasswordCard(props: { api: Api }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    setError('');
    if (next.length < 8) { setError('Password baru minimal 8 karakter.'); return; }
    if (next !== confirm) { setError('Password baru dan ulangannya tidak sama.'); return; }
    setBusy(true);
    try {
      await props.api.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="set-password" title="Ganti password" hint="Untuk akun yang sedang masuk.">
      <form className="flex flex-col gap-2.5" onSubmit={e => void submit(e)}>
        <label className={label}>Password saat ini
          <input className={field} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className={label}>Password baru
            <input className={field} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          </label>
          <label className={label}>Ulangi password baru
            <input className={field} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
        </div>
        {error && <Notice>{error}</Notice>}
        {done && <Notice tone="ok">Password diganti.</Notice>}
        <div><Button type="submit" size="sm" disabled={busy || !current || !next || !confirm}>{busy ? 'Menyimpan…' : 'Ganti password'}</Button></div>
      </form>
    </Section>
  );
}

function AccountTab(props: { api: Api }) {
  const { user, signOut } = useSession();
  return (
    <>
      <Section id="set-account" title="Akun">
        <div className="flex flex-col">
          <Row title="Email"><span className="text-[13px] text-muted-foreground">{user.email}</span></Row>
          <Row title="Peran"><span className="text-[13px] text-muted-foreground">{user.isAdmin ? 'Admin workspace' : 'Anggota'}</span></Row>
          <Row title="Keluar dari perangkat ini"><Button size="sm" variant="glass" onClick={() => void signOut()}><LogOut /> Keluar</Button></Row>
        </div>
      </Section>
      <PasswordCard api={props.api} />
    </>
  );
}

/* ---------- Anggota ---------- */

function MemberRow(props: { member: Member; me: boolean; onRole: (m: Member) => void; onRemove: (m: Member) => void; busy: boolean }) {
  const { member: m } = props;
  const [confirming, setConfirming] = useState(false);
  return (
    <li aria-label={m.email} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span aria-hidden="true" className="glass-chosen flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{m.email.slice(0, 1).toUpperCase()}</span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px]">{m.email}{props.me && <span className="text-muted-foreground"> · kamu</span>}</span>
        <span className="text-[12px] text-muted-foreground">
          Bergabung {formatDate(m.createdAt)}{m.lastSeenAt ? ` · aktif ${relativeTime(Date.parse(m.lastSeenAt))}` : ''}
        </span>
      </div>
      <Badge variant="secondary" className="ml-auto">{m.isAdmin ? 'Admin' : 'Anggota'}</Badge>
      {!props.me && (confirming ? (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Batal</Button>
          <Button size="sm" variant="destructive" disabled={props.busy} onClick={() => props.onRemove(m)}>Ya, keluarkan</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onRole(m)}>{m.isAdmin ? 'Jadikan anggota' : 'Jadikan admin'}</Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={props.busy} onClick={() => setConfirming(true)}>Keluarkan</Button>
        </div>
      ))}
    </li>
  );
}

function MembersCard(props: { api: Api }) {
  const { api } = props;
  const { user } = useSession();
  const fn = useCallback(() => api.members(), [api]);
  const { data, error, reload, setData } = useLoad(fn);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState('');

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setActionError('');
    try { await run(); reload(); } catch (e) { setActionError(errorText(e)); } finally { setBusy(undefined); }
  };
  const members = data?.members;
  return (
    <Section id="set-members" title="Anggota" hint={members ? `${members.length} orang di workspace ini · ${members.filter(m => m.isAdmin).length} admin` : 'Orang yang bisa masuk ke workspace ini.'}>
      {actionError && <Notice>{actionError}</Notice>}
      {error && !members ? <Failed what="Daftar anggota" error={error} onRetry={reload} />
        : !members ? <Rows count={3} />
        : (
          <ul className="flex flex-col">
            {members.map(m => (
              <MemberRow key={m.id} member={m} me={m.id === user.id} busy={busy === m.id}
                onRole={x => void act(x.id, async () => { const r = await api.setAdmin(x.id, !x.isAdmin); setData({ members: members.map(y => y.id === x.id ? { ...y, ...r.member, isAdmin: !x.isAdmin } : y) }); })}
                onRemove={x => void act(x.id, async () => { await api.removeMember(x.id); setData({ members: members.filter(y => y.id !== x.id) }); })} />
            ))}
          </ul>
        )}
    </Section>
  );
}

function InvitesCard(props: { api: Api }) {
  const { api } = props;
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<CreatedInvite | undefined>(undefined);
  const [invites, setInvites] = useState<Invite[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setInvites((await api.invites()).invites); } catch (e) { setError(errorText(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setCreated(await api.createInvite(email.trim()));
      setEmail('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tokenHash: string) => {
    setError('');
    try { await api.revokeInvite(tokenHash); await load(); } catch (err) { setError(errorText(err)); }
  };

  const link = created ? inviteLink(window.location.origin, created.token) : '';

  return (
    <Section id="set-invites" title="Undang anggota" hint="Akun hanya dibuat lewat undangan. Tautan berlaku 7 hari dan sekali pakai.">
      <form className="flex items-end gap-2" onSubmit={e => void submit(e)}>
        <label className={cn(label, 'flex-1')}>Email (opsional)
          <input className={field} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Kosongkan untuk siapa saja" />
        </label>
        <Button type="submit" size="lg" disabled={busy}>{busy ? 'Membuat…' : 'Buat undangan'}</Button>
      </form>
      {error && <Notice>{error}</Notice>}
      {created && (
        <div className="flex flex-col gap-1.5">
          <div className="glass-well flex items-center gap-2 rounded-md bg-muted py-1 pr-1 pl-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{link}</span>
            <CopyButton text={link} />
          </div>
          <span className="text-[12px] text-muted-foreground">Berlaku sampai {formatDate(created.expiresAt)}. Tautan hanya tampil sekali.</span>
        </div>
      )}
      {!invites && !error && <Rows count={2} />}
      {invites && invites.length === 0 && <p className="text-[12.5px] text-muted-foreground">Belum ada undangan. Buat satu di atas lalu kirim tautannya.</p>}
      {invites && invites.length > 0 && (
        <ul className="flex flex-col">
          {invites.map(invite => {
            const state = inviteState(invite);
            const name = invite.email ?? 'Siapa saja';
            return (
              <li key={invite.tokenHash} aria-label={name} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px]">{name}</span>
                  <span className="text-[12px] text-muted-foreground">Berlaku sampai {formatDate(invite.expiresAt)}</span>
                </div>
                <Badge variant="secondary" className={cn('ml-auto', tone(state.tone))}>{state.label}</Badge>
                {state.active && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void revoke(invite.tokenHash)}>Cabut</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ---------- Penggunaan ---------- */

const RANGES = [{ value: '7', label: '7 hari' }, { value: '30', label: '30 hari' }, { value: '90', label: '90 hari' }] as const;

function Stat(props: { label: string; value: number | string; testId?: string; hint?: string }) {
  return (
    <div className="glass-panel flex flex-col gap-0.5 rounded-md px-3 py-2">
      <span className="text-[11.5px] text-muted-foreground">{props.label}</span>
      <b data-testid={props.testId} className="text-[18px] font-medium tabular-nums">{props.value}</b>
      {props.hint && <span className="text-[11px] text-muted-foreground">{props.hint}</span>}
    </div>
  );
}

function Table(props: { label: string; head: string[]; children: ReactNode }) {
  return (
    <table aria-label={props.label} className="w-full text-[12.5px]">
      <thead><tr className="border-b text-left text-[11.5px] text-muted-foreground">{props.head.map((h, i) => <th key={h} className={cn('py-1.5 font-normal', i > 0 && 'text-right')}>{h}</th>)}</tr></thead>
      <tbody className="tabular-nums">{props.children}</tbody>
    </table>
  );
}

function UsageTab(props: { api: Api }) {
  const { api } = props;
  const [days, setDays] = useState<(typeof RANGES)[number]['value']>('7');
  const fn = useCallback(() => api.usage(Number(days)), [api, days]);
  const { data, error, reload } = useLoad<Usage>(fn);
  const u = data;
  const peak = u ? Math.max(1, ...u.byDay.map(d => d.jobs)) : 1;
  const empty = u && u.totals.jobs === 0;
  return (
    <Section id="set-usage" title="Penggunaan" hint="Job & kredit Flow dari semua anggota. Gambar & keyframe gratis; hanya video yang memakai kredit."
      actions={<Segmented name="Rentang" value={days} onChange={setDays} options={RANGES.map(r => ({ ...r }))} />}>
      {error && !u ? <Failed what="Data penggunaan" error={error} onRetry={reload} />
        : !u ? <Rows count={4} />
        : empty ? (
          <div className="glass-panel flex flex-col items-center gap-1 rounded-md px-4 py-8 text-center">
            <b className="text-[13px] font-medium">Belum ada pemakaian di {u.range.days} hari terakhir</b>
            <span className="text-[12.5px] text-muted-foreground">Begitu ada cerita atau klip dibuat, kredit dan job muncul di sini per akun dan per anggota.</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Kredit terpakai" value={u.totals.credits} testId="usage-credits" />
              <Stat label="Job" value={u.totals.jobs} testId="usage-jobs" hint={`${u.totals.done} selesai · ${u.totals.failed} gagal`} />
              <Stat label="Sedang jalan" value={u.totals.running + u.totals.queued} hint={`${u.totals.running} jalan · ${u.totals.queued} antre`} />
              <Stat label="Tingkat sukses" value={`${u.totals.jobs ? Math.round((u.totals.done / u.totals.jobs) * 100) : 0}%`} />
            </div>
            <figure className="flex flex-col gap-1.5">
              <figcaption className="text-[11.5px] text-muted-foreground">Job per hari · {u.range.from} – {u.range.to} · arahkan kursor untuk kredit</figcaption>
              <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={`Job per hari, puncak ${peak}`}>
                {u.byDay.map(d => (
                  <span key={d.date} data-testid="usage-bar" title={`${d.date}: ${d.credits} kredit · ${d.jobs} job`}
                    className="min-w-0 flex-1 rounded-t-[3px] bg-foreground/70 hover:bg-foreground" style={{ height: `${Math.max(2, (d.jobs / peak) * 100)}%`, opacity: d.jobs ? 1 : 0.25 }} />
                ))}
              </div>
            </figure>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              {(['video', 'image', 'character'] as const).map(k => (
                <div key={k} className="rounded-md bg-muted px-2.5 py-1.5">
                  <span className="text-muted-foreground">{k === 'video' ? 'Video' : k === 'image' ? 'Gambar' : 'Karakter'}</span>
                  <div className="tabular-nums">{u.byKind[k]?.done ?? 0}/{u.byKind[k]?.jobs ?? 0} job · {u.byKind[k]?.credits ?? 0} kredit</div>
                </div>
              ))}
            </div>
            <Table label="Per akun Flow" head={['Akun', 'Job', 'Kredit', 'Hari ini / batas', 'Sisa']}>
              {u.byAccount.length === 0 && <tr><td colSpan={5} className="py-2 text-muted-foreground">Belum ada akun Flow — tambahkan di tab Akun Flow.</td></tr>}
              {u.byAccount.map(a => (
                <tr key={a.accountId} aria-label={a.label} className="border-b border-border/60 last:border-b-0">
                  <td className="py-1.5">{a.label}{!a.enabled && <span className="text-muted-foreground"> · nonaktif</span>}</td>
                  <td className="text-right">{a.done}/{a.jobs}</td>
                  <td className="text-right">{a.credits}</td>
                  <td className="text-right">{a.creditsUsedToday} / {a.dailyCreditCap ?? '∞'}</td>
                  <td className="text-right">{a.creditsRemaining ?? '—'}</td>
                </tr>
              ))}
            </Table>
            <Table label="Per anggota" head={['Anggota', 'Job', 'Kredit']}>
              {u.byMember.map(m => (
                <tr key={m.userId} aria-label={m.email ?? 'Tanpa pemilik'} className="border-b border-border/60 last:border-b-0">
                  <td className="py-1.5">{m.email ?? <span className="text-muted-foreground">Tanpa pemilik (job lama)</span>}</td>
                  <td className="text-right">{m.done}/{m.jobs}</td>
                  <td className="text-right">{m.credits}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
    </Section>
  );
}

/* ---------- Akun Flow ---------- */

const ROTATIONS: Array<{ value: Rotation; label: string; hint: string }> = [
  { value: 'least-used', label: 'Paling jarang dipakai', hint: 'Ambil akun dengan kredit terpakai hari ini paling sedikit. Kuota rata.' },
  { value: 'round-robin', label: 'Round-robin', hint: 'Bergiliran: akun yang paling lama tidak dipakai lebih dulu.' },
  { value: 'priority', label: 'Prioritas', hint: 'Habiskan akun berprioritas tertinggi (angka terkecil) dulu, sisanya cadangan.' }
];

function PoolCard(props: { api: Api }) {
  const { api } = props;
  const fn = useCallback(() => api.pool(), [api]);
  const { data, error, reload, setData } = useLoad(fn);
  const [saveError, setSaveError] = useState('');
  const current: Rotation = data?.pool?.rotation ?? 'least-used';
  const choose = async (rotation: Rotation) => {
    setSaveError('');
    const before = data;
    setData({ pool: { rotation } });
    try { setData(await api.setPool(rotation)); } catch (e) { setData(before); setSaveError(errorText(e)); }
  };
  return (
    <Section id="set-pool" title="Rotasi akun" hint="Cara bridge memilih akun Google Flow untuk tiap job. Satu cerita tetap di satu akun agar karakternya konsisten.">
      {error && !data ? <Failed what="Pengaturan rotasi" error={error} onRetry={reload} />
        : !data ? <Rows count={3} />
        : (
          <div role="radiogroup" aria-label="Strategi rotasi" className="grid gap-2 sm:grid-cols-3">
            {ROTATIONS.map(r => (
              <button key={r.value} type="button" role="radio" aria-checked={current === r.value} aria-label={r.label} onClick={() => void choose(r.value)}
                className={cn('flex flex-col gap-1 rounded-md border px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                  current === r.value && 'glass-chosen border-transparent')}>
                <span className="text-[13px] text-foreground">{r.label}</span>
                <span className="text-[11.5px] leading-snug text-muted-foreground">{r.hint}</span>
              </button>
            ))}
          </div>
        )}
      {saveError && <Notice>{saveError}</Notice>}
    </Section>
  );
}

function NumberField(props: { label: string; value?: number; placeholder?: string; onCommit: (v: number | null) => void; min?: number }) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  useEffect(() => { setText(props.value === undefined ? '' : String(props.value)); }, [props.value]);
  const commit = () => {
    const t = text.trim();
    const next = t === '' ? null : Number(t);
    const prev = props.value ?? null;
    if (next === prev || (next !== null && (!Number.isInteger(next) || next < (props.min ?? 0)))) { if (next !== prev) setText(prev === null ? '' : String(prev)); return; }
    props.onCommit(next);
  };
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      {props.label}
      <input type="number" inputMode="numeric" min={props.min ?? 0} aria-label={props.label} placeholder={props.placeholder}
        value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="h-7 w-16 rounded-md border bg-(--field) px-1.5 text-right text-[12.5px] text-foreground tabular-nums outline-none focus-visible:border-ring" />
    </label>
  );
}

function AccountRow(props: { account: FlowAccount; onRemove: (id: string) => Promise<void>; onPatch: (id: string, patch: Parameters<Api['updateAccount']>[1]) => Promise<void> }) {
  const { account: a } = props;
  const [confirming, setConfirming] = useState(false);
  const status = ACCOUNT_STATUS[a.status] ?? { label: a.status, tone: '' };
  const enabled = a.enabled !== false;
  return (
    <li aria-label={a.label} className={cn('flex flex-col gap-2 border-b border-border/60 py-2.5 last:border-b-0', !enabled && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px]">{a.label}</span>
          <span className="truncate text-[12px] text-muted-foreground">
            {a.email}{a.profileDir && <> · <span className="font-mono">{a.profileDir}</span></>}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {typeof a.credits === 'number' ? `${a.credits} kredit` : 'kredit belum diketahui'}
            {' · '}{typeof a.dailyCreditCap === 'number' ? `${a.creditsUsedToday} / ${a.dailyCreditCap} kredit hari ini` : `${a.creditsUsedToday} kredit terpakai hari ini`}
            {a.status === 'cooldown' && a.cooldownUntilMs ? ` · jeda sampai ${new Date(a.cooldownUntilMs).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : ''}
            {a.lastUsedAtMs ? ` · dipakai ${relativeTime(a.lastUsedAtMs)}` : ''}
          </span>
          {a.lastError && <span className="text-[12px] text-destructive">{a.lastError}</span>}
        </div>
        <Badge variant="secondary" className={cn('ml-auto shrink-0', tone(status.tone))}>{status.label}</Badge>
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <Switch aria-label={`Aktif ${a.label}`} checked={enabled} onCheckedChange={v => void props.onPatch(a.id, { enabled: v })} /> Aktif
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <NumberField label="Prioritas" value={a.priority ?? 0} onCommit={v => void props.onPatch(a.id, { priority: v ?? 0 })} />
        <NumberField label="Batas kredit harian" value={a.dailyCreditCap} placeholder="∞" onCommit={v => void props.onPatch(a.id, { dailyCreditCap: v })} />
        {confirming ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Batal</Button>
            <Button size="sm" variant="destructive" onClick={() => void props.onRemove(a.id)}>Yakin hapus</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => setConfirming(true)}>Hapus</Button>
        )}
      </div>
    </li>
  );
}

function FlowCard(props: { api: Api }) {
  const { api } = props;
  const [accounts, setAccounts] = useState<FlowAccount[] | undefined>(undefined);
  const [bridge, setBridge] = useState<BridgeStatus | undefined>(undefined);
  const [labelText, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [profileDir, setProfileDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.flow();
      setAccounts(r.accounts);
      setBridge(r.bridge);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.addFlowAccount({ label: labelText.trim(), email: email.trim(), ...(profileDir.trim() ? { profileDir: profileDir.trim() } : {}) });
      setLabel(''); setEmail(''); setProfileDir('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError('');
    try { await api.removeFlowAccount(id); await load(); } catch (err) { setError(errorText(err)); }
  };
  const patch = async (id: string, p: Parameters<Api['updateAccount']>[1]) => {
    setError('');
    setAccounts(list => list?.map(a => a.id === id ? { ...a, ...p, dailyCreditCap: 'dailyCreditCap' in p ? p.dailyCreditCap ?? undefined : a.dailyCreditCap } : a));
    try {
      const { account } = await api.updateAccount(id, p);
      if (account) setAccounts(list => list?.map(a => a.id === id ? account : a));
    } catch (err) { setError(errorText(err)); await load(); }
  };

  return (
    <Section id="set-flow" title="Akun Flow & bridge" hint="Akun Google Flow yang dipakai bridge untuk gambar dan video.">
      {bridge && accounts && (
        <div className="grid grid-cols-3 gap-2">
          <div className="glass-panel flex flex-col gap-0.5 rounded-md px-3 py-2">
            <span className={cn('text-[13px] font-medium', bridge.online ? 'text-(--success)' : 'text-destructive')}>{bridge.online ? 'Online' : 'Offline'}</span>
            <span className="text-[11.5px] text-muted-foreground">
              {bridge.lastSeenMs ? `Terakhir terlihat ${relativeTime(bridge.lastSeenMs)}` : 'Bridge belum pernah terhubung'}
              {bridge.bridgeId && <> · <span className="font-mono">{bridge.bridgeId}</span></>}
            </span>
          </div>
          <Stat label="Total kredit" value={totalCredits(accounts)} testId="credits-total" />
          <Stat label="Akun aktif" value={`${accounts.filter(a => a.enabled !== false).length}/${accounts.length}`} />
        </div>
      )}
      {!accounts && !error && <Rows count={2} />}
      {accounts && accounts.length === 0 && (
        <div className="glass-panel flex flex-col gap-1 rounded-md px-4 py-5">
          <h3 className="text-[13px] font-medium">Belum ada akun Flow</h3>
          <span className="text-[12.5px] text-muted-foreground">Bridge butuh minimal satu akun Google Flow untuk membuat gambar dan video. Tambahkan akun di bawah dengan profile Chrome khusus Flow di Mac (cdp:http://127.0.0.1:9333).</span>
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <ul className="flex flex-col">
          {accounts.map(a => <AccountRow key={a.id} account={a} onRemove={remove} onPatch={patch} />)}
        </ul>
      )}
      <form className="flex flex-col gap-2" onSubmit={e => void add(e)}>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className={label}>Label<input className={field} value={labelText} onChange={e => setLabel(e.target.value)} /></label>
          <label className={label}>Email Google<input className={field} type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className={label}>Profil Chrome (opsional)<input className={field} value={profileDir} onChange={e => setProfileDir(e.target.value)} /></label>
        </div>
        {error && <Notice>{error}</Notice>}
        <div><Button type="submit" size="sm" disabled={busy || !labelText.trim()}>{busy ? 'Menambah…' : 'Tambah akun'}</Button></div>
      </form>
    </Section>
  );
}

/* ---------- the page ---------- */

export default function SettingsPage(props: { tab?: SettingsTab; onTab?: (tab: SettingsTab) => void }) {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => settingsApi(fetchImpl), [fetchImpl]);
  const tabs = TABS.filter(t => !t.admin || user.isAdmin);
  const wanted = props.tab ?? 'umum';
  const [own, setOwn] = useState<SettingsTab>(tabs.some(t => t.id === wanted) ? wanted : 'umum');
  useEffect(() => { setOwn(tabs.some(t => t.id === wanted) ? wanted : 'umum'); }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (t: SettingsTab) => { setOwn(t); props.onTab?.(t); };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div role="tablist" aria-label="Pengaturan" aria-orientation="vertical"
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-48 md:flex-col md:border-r md:border-b-0">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={own === t.id} onClick={() => choose(t.id)}
            className={cn('flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-[13px] text-foreground/80 outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:text-muted-foreground',
              own === t.id && 'glass-chosen text-foreground [&_svg]:text-foreground')}>
            <t.icon aria-hidden="true" />{t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${own}`} aria-labelledby={`tab-${own}`} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5 [scrollbar-width:thin]">
        {own === 'umum' && <GeneralTab />}
        {own === 'akun' && <AccountTab api={api} />}
        {own === 'anggota' && <><MembersCard api={api} /><InvitesCard api={api} /></>}
        {own === 'penggunaan' && <UsageTab api={api} />}
        {own === 'flow' && <><PoolCard api={api} /><FlowCard api={api} /></>}
        {own === 'koneksi' && <ConnectionsPanel />}
      </div>
    </div>
  );
}

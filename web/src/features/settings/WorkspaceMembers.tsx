/**
 * Pengaturan › Anggota workspace (wave 4): who is in this workspace, with which role, and the
 * pending invites. Inviting, changing a role and removing someone are the owner's jobs; an
 * editor or viewer sees the same list read-only with one line saying why.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Mail, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { useWorkspaceState } from '../../lib/workspace.js';
import { describeError } from '../../ui/states.js';
import { Choice, Field, inputClass } from '../../ui/controls.js';
import { RoleBadge } from '../../ui/RoleBadge.js';
import {
  ROLE_HINT, ROLE_LABEL, canManage, inviteState, inviteUrl, roleOf, workspacesApi,
  type CreatedInvite, type Role, type WorkspaceDetail, type WorkspaceInvite, type WorkspaceMember, type WorkspaceSummary
} from '../../lib/workspaces.js';

const when = (ms: number) => new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

function Section(props: { id: string; title: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="flex flex-col gap-2 border-b pb-5 last:border-b-0 last:pb-0">
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

function Failed(props: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1">{props.what} gagal dimuat. {describeError(props.error)}</span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}>Coba lagi</Button>
    </div>
  );
}

function CopyLink(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button type="button" size="sm" variant="ghost" aria-label="Salin tautan undangan"
      onClick={() => { void navigator.clipboard?.writeText(props.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => undefined); }}>
      {copied ? <Check /> : <Copy />} {copied ? 'Tersalin' : 'Salin'}
    </Button>
  );
}

function MemberRow(props: {
  member: WorkspaceMember; me: boolean; manage: boolean; busy: boolean;
  onRole: (m: WorkspaceMember, role: Role) => void; onRemove: (m: WorkspaceMember) => void;
}) {
  const m = props.member;
  const role = roleOf(m.role);
  return (
    <li aria-label={m.email} className="flex flex-wrap items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span aria-hidden="true" className="glass-chosen flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{m.email.slice(0, 1).toUpperCase()}</span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px]">{m.email}{props.me && <span className="text-muted-foreground"> · kamu</span>}</span>
        <span className="text-[12px] text-muted-foreground">Bergabung {when(m.joinedAtMs)}</span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {props.manage && !props.me && role !== 'owner' ? (
          <Choice label={`Peran ${m.email}`} size="sm" value={role} disabled={props.busy}
            options={(['editor', 'viewer', 'owner'] as Role[]).map(r => ({ value: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r] }))}
            onChange={r => props.onRole(m, r)} />
        ) : (
          <RoleBadge role={role} />
        )}
        {props.manage && !props.me && role !== 'owner' && (
          <Button size="sm" variant="ghost" className="text-destructive" disabled={props.busy} onClick={() => props.onRemove(m)}>
            <UserMinus /> Keluarkan
          </Button>
        )}
      </div>
    </li>
  );
}

function InviteDialog(props: { invite: CreatedInvite; email: string; onClose: () => void }) {
  const link = inviteUrl(typeof window === 'undefined' ? '' : window.location.origin, props.invite.url);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="glass-well flex items-center gap-2 rounded-md bg-muted py-1 pr-1 pl-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{link}</span>
        <CopyLink text={link} />
      </div>
      <p className="text-[12px] text-muted-foreground">
        Undangan untuk {props.email || props.invite.invite.email} sebagai {ROLE_LABEL[props.invite.invite.role]} · berlaku sampai {when(props.invite.invite.expiresAtMs)} · hanya bisa dipakai sekali.
      </p>
      <div><Button size="sm" variant="ghost" onClick={props.onClose}>Tutup</Button></div>
    </div>
  );
}

export function WorkspaceMembersPanel() {
  const { user, fetchImpl } = useSession();
  const ctx = useWorkspaceState();
  const api = useMemo(() => workspacesApi(fetchImpl), [fetchImpl]);
  const [summary, setSummary] = useState<WorkspaceSummary>();
  const [detail, setDetail] = useState<WorkspaceDetail>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [created, setCreated] = useState<CreatedInvite>();
  const [removing, setRemoving] = useState<WorkspaceMember>();

  useEffect(() => {
    let alive = true;
    setError(undefined);
    (async () => {
      const { workspaces } = await api.list();
      const want = (ctx.current && workspaces.find(w => w.id === ctx.current?.id)) ?? workspaces[0];
      const got = want ? await api.get(want.id) : undefined;
      if (!alive) return;
      setSummary(want);
      setDetail(got);
    })().catch(e => { if (alive) { setSummary(undefined); setDetail(undefined); setError(e); } });
    return () => { alive = false; };
  }, [api, ctx.current?.id, tick]);

  const members = detail?.members;
  const invites = detail?.invites;
  const manage = canManage(summary?.role);
  const me = members?.find(m => m.userId === user.id);

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key); setActionError(''); setNotice('');
    try { await run(); setNotice(done); reload(); } catch (e) { setActionError(describeError(e)); } finally { setBusy(undefined); }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!summary || !email.trim()) return;
    void act('invite', async () => {
      const r = await api.invite(summary.id, email, role);
      setCreated(r); setEmail('');
    }, `Undangan dikirim ke ${email.trim().toLowerCase()}.`);
  };

  const active = (invites ?? []).filter(i => inviteState(i).active);

  return (
    <div aria-label="Anggota workspace" role="region" className="flex flex-col gap-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-[15px] font-medium">{summary?.name ?? 'Workspace'}</h1>
        {summary && <RoleBadge role={summary.role} />}
        <span className="text-[12px] text-muted-foreground">
          {members ? `${members.length} orang · ${active.length} undangan tertunda` : 'Memuat anggota…'}
        </span>
      </div>

      {!!error && !detail && <Failed what="Anggota workspace" error={error} onRetry={reload} />}
      {!detail && !error && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Memuat anggota workspace">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      )}

      {detail && !manage && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-[12.5px] text-muted-foreground">
          Kamu {ROLE_LABEL[summary?.role ?? 'viewer']} di workspace ini — hanya Pemilik yang bisa mengundang, mengubah peran, atau mengeluarkan anggota.
        </p>
      )}
      {actionError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{actionError}</p>}
      {notice && <p role="status" className="text-[12.5px] text-(--success)">{notice}</p>}

      {detail && manage && (
        <Section id="ws-invite" title="Undang lewat email" hint="Undangan berlaku 7 hari dan sekali pakai. Orang yang belum punya akun membuatnya lewat tautan ini.">
          <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
            <Field label="Email" className="min-w-56 flex-1">
              <input className={inputClass} type="email" required value={email} placeholder="nama@email.com"
                aria-label="Email yang diundang" onChange={e => setEmail(e.target.value)} />
            </Field>
            <Field label="Peran">
              <Choice label="Peran undangan" value={role} onChange={setRole}
                options={(['editor', 'viewer', 'owner'] as Role[]).map(r => ({ value: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r] }))} />
            </Field>
            <Button type="submit" size="lg" disabled={busy === 'invite'}>
              <UserPlus /> {busy === 'invite' ? 'Mengirim…' : 'Kirim undangan'}
            </Button>
          </form>
          {created && <InviteDialog invite={created} email="" onClose={() => setCreated(undefined)} />}
        </Section>
      )}

      <Section id="ws-members" title="Anggota" hint="Satu orang bisa menjadi anggota beberapa workspace; perannya bisa berbeda di tiap workspace.">
        {members && members.length === 0 && <p className="text-[12.5px] text-muted-foreground">Belum ada anggota lain di workspace ini.</p>}
        {members && members.length > 0 && (
          <ul aria-label="Anggota" className="flex flex-col">
            {members.map(m => (
              <MemberRow key={m.userId} member={m} me={m.userId === user.id} manage={manage} busy={busy === m.userId}
                onRemove={setRemoving}
                onRole={(x, r) => void act(x.userId, () => api.setRole(detail.workspace.id, x.userId, r), `${x.email} sekarang ${ROLE_LABEL[r]}.`)} />
            ))}
          </ul>
        )}
      </Section>

      {detail && manage && (
        <Section id="ws-invites" title="Undangan tertunda" hint="Cabut undangan yang salah alamat — tautannya langsung berhenti bekerja.">
          {invites === undefined && <div className="flex flex-col gap-2" aria-busy="true"><Skeleton className="h-8 w-full rounded-md" /></div>}
          {invites && invites.length === 0 && <p className="text-[12.5px] text-muted-foreground">Belum ada undangan tertunda. Undang seseorang lewat email di atas.</p>}
          {invites && invites.length > 0 && (
            <ul aria-label="Undangan tertunda" className="flex flex-col">
              {invites.map(invite => {
                const state = inviteState(invite);
                return (
                  <li key={invite.id} aria-label={invite.email} className="flex flex-wrap items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
                    <Mail aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px]">{invite.email}</span>
                      <span className="text-[12px] text-muted-foreground">Berlaku sampai {when(invite.expiresAtMs)}</span>
                    </div>
                    <span className="ml-auto flex items-center gap-1.5">
                      <RoleBadge role={roleOf(invite.role)} />
                      <Badge variant="secondary" className={cn('font-normal', state.active ? 'text-(--success)' : 'text-muted-foreground')}>{state.label}</Badge>
                    </span>
                    {state.active && (
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === invite.id}
                        onClick={() => void act(invite.id, () => api.revokeInvite(detail.workspace.id, invite.id), `Undangan untuk ${invite.email} dicabut.`)}>
                        Cabut
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {detail && me && !manage && (
        <Section id="ws-leave" title="Keluar dari workspace" hint="Proyek yang pernah kamu buat tetap di workspace ini; kamu kehilangan akses ke semuanya.">
          <Button size="sm" variant="ghost" className="w-fit text-destructive" disabled={busy === 'leave'}
            onClick={() => void act('leave', () => api.removeMember(detail.workspace.id, me.userId), 'Kamu keluar dari workspace ini.')}>
            <UserMinus /> Keluar dari workspace
          </Button>
        </Section>
      )}

      <AlertDialog open={!!removing} onOpenChange={open => { if (!open) setRemoving(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keluarkan {removing?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Dia langsung kehilangan akses ke workspace ini: tidak bisa membuka, mengubah, atau merender proyeknya lagi.
              Proyek yang pernah dibuatnya tetap di workspace dan tidak terhapus. Undangan baru bisa dikirim kapan saja.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { const x = removing; setRemoving(undefined); if (x && detail) void act(x.userId, () => api.removeMember(detail.workspace.id, x.userId), `${x.email} dikeluarkan dari workspace.`); }}>
              Ya, keluarkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Which inbox an invite went to, for the empty state of the panel above. */
export function inviteFacts(invite: WorkspaceInvite) {
  return `${invite.email} · ${ROLE_LABEL[roleOf(invite.role)]} · ${inviteState(invite).label}`;
}

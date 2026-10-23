import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import {
  ACCOUNT_STATUS,
  errorText,
  formatDate,
  inviteLink,
  inviteState,
  relativeTime,
  settingsApi,
  totalCredits,
  type BridgeStatus,
  type CreatedInvite,
  type FlowAccount,
  type Invite
} from './settingsClient.js';

type Api = ReturnType<typeof settingsApi>;

function Card(props: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={props.id}>
      <div className="card-head">
        <div>
          <h2 id={props.id}>{props.title}</h2>
          <span className="muted">{props.hint}</span>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn btn-sm" onClick={() => {
      void navigator.clipboard?.writeText(props.text).then(() => setCopied(true), () => undefined);
    }}>
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Tersalin' : 'Salin'}
    </button>
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
    <Card id="set-invites" title="Undang anggota" hint="Akun hanya dibuat lewat undangan.">
      <form className="stack" onSubmit={e => void submit(e)}>
        <div className="form-row">
          <label className="field">Email (opsional)
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Kosongkan untuk siapa saja" />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Membuat…' : 'Buat undangan'}</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      {created && (
        <div className="stack">
          <div className="link-box">
            <span className="mono">{link}</span>
            <CopyButton text={link} />
          </div>
          <span className="muted">Berlaku sampai {formatDate(created.expiresAt)}. Tautan hanya tampil sekali.</span>
        </div>
      )}
      {invites && invites.length > 0 && (
        <ul className="list">
          {invites.map(invite => {
            const state = inviteState(invite);
            const name = invite.email ?? 'Siapa saja';
            return (
              <li key={invite.tokenHash} className="row" aria-label={name}>
                <div className="row-main">
                  <strong>{name}</strong>
                  <div className="muted">Berlaku sampai {formatDate(invite.expiresAt)}</div>
                </div>
                <span className={`pill ${state.tone}`}>{state.label}</span>
                {state.active && (
                  <button className="btn btn-sm btn-danger" onClick={() => void revoke(invite.tokenHash)}>Cabut</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function AccountRow(props: { account: FlowAccount; onRemove: (id: string) => Promise<void> }) {
  const { account } = props;
  const [confirming, setConfirming] = useState(false);
  const status = ACCOUNT_STATUS[account.status] ?? { label: account.status, tone: '' };
  return (
    <li className="row" aria-label={account.label}>
      <div className="row-main">
        <strong>{account.label}</strong>
        <div className="muted">
          {account.email}
          {account.profileDir && <> · <span className="mono">{account.profileDir}</span></>}
        </div>
        <div className="muted">
          {typeof account.credits === 'number' ? `${account.credits} kredit` : 'kredit belum diketahui'}
          {' · '}{account.creditsUsedToday} terpakai hari ini
          {account.status === 'cooldown' && account.cooldownUntilMs ? ` · jeda sampai ${new Date(account.cooldownUntilMs).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
        {account.lastError && <div className="form-error">{account.lastError}</div>}
      </div>
      <span className={`pill ${status.tone}`}>{status.label}</span>
      {confirming ? (
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => setConfirming(false)}>Batal</button>
          <button className="btn btn-sm btn-danger" onClick={() => void props.onRemove(account.id)}>Yakin hapus</button>
        </div>
      ) : (
        <button className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>Hapus</button>
      )}
    </li>
  );
}

function FlowCard(props: { api: Api }) {
  const { api } = props;
  const [accounts, setAccounts] = useState<FlowAccount[] | undefined>(undefined);
  const [bridge, setBridge] = useState<BridgeStatus | undefined>(undefined);
  const [label, setLabel] = useState('');
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
      await api.addFlowAccount({ label: label.trim(), email: email.trim(), ...(profileDir.trim() ? { profileDir: profileDir.trim() } : {}) });
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

  return (
    <Card id="set-flow" title="Akun Flow & bridge" hint="Akun Google Flow yang dipakai bridge untuk render klip.">
      {bridge && accounts && (
        <div className="kpis">
          <div className="kpi">
            <b><span className={`pill ${bridge.online ? 'done' : 'failed'}`}>{bridge.online ? 'Online' : 'Offline'}</span></b>
            <span>
              {bridge.lastSeenMs ? `Terakhir terlihat ${relativeTime(bridge.lastSeenMs)}` : 'Bridge belum pernah terhubung'}
              {bridge.bridgeId && <> · <span className="mono">{bridge.bridgeId}</span></>}
            </span>
          </div>
          <div className="kpi"><b data-testid="credits-total">{totalCredits(accounts)}</b><span>Total kredit</span></div>
          <div className="kpi"><b>{accounts.length}</b><span>Akun</span></div>
        </div>
      )}
      {accounts && accounts.length === 0 && <p className="empty">Belum ada akun Flow.</p>}
      {accounts && accounts.length > 0 && (
        <ul className="list">
          {accounts.map(a => <AccountRow key={a.id} account={a} onRemove={remove} />)}
        </ul>
      )}
      <form className="stack" onSubmit={e => void add(e)}>
        <div className="form-row">
          <label className="field">Label
            <input value={label} onChange={e => setLabel(e.target.value)} />
          </label>
          <label className="field">Email Google
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label className="field">Profil Chrome (opsional)
            <input value={profileDir} onChange={e => setProfileDir(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-row">
          <button className="btn btn-primary" type="submit" disabled={busy || !label.trim()}>{busy ? 'Menambah…' : 'Tambah akun'}</button>
        </div>
      </form>
    </Card>
  );
}

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
    <Card id="set-password" title="Ganti password" hint="Untuk akun yang sedang masuk.">
      <form className="stack" onSubmit={e => void submit(e)}>
        <label className="field">Password saat ini
          <input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <div className="form-row">
          <label className="field">Password baru
            <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          </label>
          <label className="field">Ulangi password baru
            <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {done && <p className="notice" role="status">Password diganti.</p>}
        <div className="form-row">
          <button className="btn btn-primary" type="submit" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Menyimpan…' : 'Ganti password'}
          </button>
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => settingsApi(fetchImpl), [fetchImpl]);
  return (
    <>
      {user.isAdmin && <InvitesCard api={api} />}
      {user.isAdmin && <FlowCard api={api} />}
      <PasswordCard api={api} />
    </>
  );
}

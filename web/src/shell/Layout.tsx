import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { BookOpenText, Clapperboard, LogOut, Send, Settings, Type, type LucideIcon } from 'lucide-react';
import { requestJson } from '../lib/api.js';
import { useSession } from '../lib/session.js';

type NavItem = { to: string; label: string; hint: string; icon: LucideIcon };

/** Ordered by the workflow: make → distribute → configure. */
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Buat', items: [
    { to: '/cerita', label: 'Cerita', hint: 'Film pendek dari premis', icon: BookOpenText },
    { to: '/studio', label: 'Studio', hint: 'Klip & gambar satuan', icon: Clapperboard },
    { to: '/generate', label: 'Alat cepat', hint: 'Naskah, suara, gambar', icon: Type }
  ] },
  { label: 'Distribusi', items: [
    { to: '/publish', label: 'Publish', hint: 'YouTube & sosmed', icon: Send }
  ] },
  { label: 'Sistem', items: [
    { to: '/pengaturan', label: 'Pengaturan', hint: 'Akun Flow & undangan', icon: Settings }
  ] }
];
export const NAV = NAV_GROUPS.flatMap(g => g.items);

type BridgeInfo = { online: boolean; credits?: number; accounts: number } | 'error' | undefined;

/** Real bridge/Flow state, so "why is nothing rendering?" has an answer on every page. */
function BridgeStatus() {
  const { user, fetchImpl } = useSession();
  const [info, setInfo] = useState<BridgeInfo>();
  useEffect(() => {
    if (!user.isAdmin) return;
    let alive = true;
    const load = () => requestJson<{ accounts: Array<{ credits?: number }>; bridge: { online: boolean } }>(fetchImpl, '/api/flow/accounts')
      .then(r => alive && setInfo({
        online: !!r.bridge?.online,
        accounts: r.accounts.length,
        ...(r.accounts.some(a => typeof a.credits === 'number') ? { credits: r.accounts.reduce((t, a) => t + (a.credits ?? 0), 0) } : {})
      }), () => alive && setInfo('error'));
    void load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [user.isAdmin, fetchImpl]);
  if (!user.isAdmin || info === undefined) return null;
  const text = info === 'error' ? 'Status bridge tidak terbaca'
    : !info.online ? 'Bridge offline · render menunggu Mac'
    : `Bridge online${info.credits !== undefined ? ` · ${info.credits} kredit` : ''}`;
  const tone = info === 'error' ? 'unknown' : info.online ? 'on' : 'off';
  return (
    <NavLink to="/pengaturan" className={`bridge-status ${tone}`} role="status" aria-label={`Bridge: ${text}`}>
      <i aria-hidden="true" /> <span>{text}</span>
    </NavLink>
  );
}

function AccountMenu() {
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);

  return (
    <div className="account" ref={ref}>
      <button className="avatar" aria-label="Akun" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {user.email.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="popover" role="menu">
          <div className="popover-head">
            <strong>{user.email}</strong>
            <span className="muted">{user.isAdmin ? 'Admin' : 'Anggota'}</span>
          </div>
          <NavLink className="popover-item" role="menuitem" to="/pengaturan" onClick={() => setOpen(false)}>
            <Settings size={15} /> Pengaturan
          </NavLink>
          <button className="popover-item" role="menuitem" onClick={() => void signOut()}>
            <LogOut size={15} /> Keluar
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden>N</span><span>Creator</span></div>
        <nav aria-label="Menu utama">
          {NAV_GROUPS.map(group => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map(item => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                  <item.icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-text"><span>{item.label}</span><small>{item.hint}</small></span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <BridgeStatus />
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{props.title}</h1>
          <div className="topbar-actions">{props.actions}<AccountMenu /></div>
        </header>
        <div className="content">{props.children}</div>
      </div>
    </div>
  );
}

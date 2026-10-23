import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { BookOpenText, Clapperboard, Send, Settings, Sparkles, LogOut, type LucideIcon } from 'lucide-react';
import { useSession } from '../lib/session.js';

export const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/cerita', label: 'Cerita', icon: BookOpenText },
  { to: '/studio', label: 'Studio', icon: Clapperboard },
  { to: '/generate', label: 'Generate', icon: Sparkles },
  { to: '/publish', label: 'Publish', icon: Send },
  { to: '/pengaturan', label: 'Pengaturan', icon: Settings }
];

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
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <item.icon size={17} strokeWidth={1.8} /> <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
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

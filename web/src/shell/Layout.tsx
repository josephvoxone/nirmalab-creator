import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpenText, Clapperboard, Gauge, LayoutGrid, LogOut, PanelLeft, Search, Send, Server, Settings, SquarePen, Users, Wand2, type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { requestJson } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useHistory } from './history.js';
import { STATUS_LABEL, isActive, type Story } from '../features/stories/storiesClient.js';

type NavItem = { to: string; label: string; icon: LucideIcon };

/** The tools, after "new" and "search" — like ChatGPT's Library / GPTs rows. */
export const TOOLS: NavItem[] = [
  { to: '/template', label: 'Template', icon: LayoutGrid },
  { to: '/studio', label: 'Studio', icon: Clapperboard },
  { to: '/generate', label: 'Alat cepat', icon: Wand2 },
  { to: '/publish', label: 'Publish', icon: Send },
  { to: '/cerita', label: 'Semua cerita', icon: BookOpenText }
];
/** Kept for older imports. */
export const NAV = TOOLS;

const rowClass = 'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-foreground/85 transition-colors outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const chosenClass = 'glass-chosen text-foreground [&_svg]:text-foreground';

function SideLink(props: { to: string; end?: boolean; icon: LucideIcon; children: ReactNode; onPick?: () => void }) {
  return (
    <NavLink to={props.to} end={props.end} onClick={props.onPick} className={({ isActive }) => cn(rowClass, isActive && chosenClass)}>
      <props.icon aria-hidden="true" /> <span className="truncate">{props.children}</span>
    </NavLink>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" aria-label={props.label} title={props.label} onClick={props.onClick}
      className={cn('flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4', props.className)}>
      {props.children}
    </button>
  );
}

function storyDot(s: Story) {
  if (isActive(s)) return 'bg-(--status-running) animate-pulse';
  if (s.status === 'done') return 'bg-(--status-done)';
  if (s.status === 'failed') return 'bg-destructive';
  if (s.status === 'review') return 'bg-(--brand)';
  return 'bg-muted-foreground/40';
}

function StoryRow(props: { story: Story; onPick?: () => void }) {
  const s = props.story;
  return (
    <li>
      <NavLink to={`/cerita/${s.id}`} onClick={props.onPick} title={`${s.title} · ${STATUS_LABEL[s.status] ?? s.status}`}
        className={({ isActive }) => cn(rowClass, 'h-7 gap-2 text-[12.5px]', isActive && chosenClass)}>
        <i aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', storyDot(s))} />
        <span className="truncate">{s.title}</span>
      </NavLink>
    </li>
  );
}

function History(props: { onPick?: () => void }) {
  const { stories, error, reload } = useHistory();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-width:thin]">
      <p className="px-3.5 pt-5 pb-1 text-xs text-muted-foreground">Cerita terbaru</p>
      {error && !stories ? (
        <div className="mx-2 flex flex-col gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground" role="alert">
          Gagal memuat riwayat.
          <button type="button" onClick={reload} aria-label="Muat ulang riwayat" className="w-fit rounded-sm text-foreground underline underline-offset-3">Coba lagi</button>
        </div>
      ) : !stories ? (
        <div className="flex flex-col gap-2 px-3.5 pt-1" aria-busy="true" aria-label="Memuat riwayat">
          {[70, 55, 80, 60].map(w => <Skeleton key={w} className="h-3.5" style={{ width: `${w}%` }} />)}
        </div>
      ) : stories.length === 0 ? (
        <p className="px-3.5 py-1 text-xs leading-5 text-muted-foreground">Belum ada cerita. Tulis prompt di <b className="font-medium text-foreground/80">Buat baru</b> untuk memulai.</p>
      ) : (
        <ul aria-label="Cerita terbaru" className="flex flex-col gap-px px-1.5">
          {stories.slice(0, 40).map(s => <StoryRow key={s.id} story={s} onPick={props.onPick} />)}
        </ul>
      )}
    </div>
  );
}

type BridgeInfo = { online: boolean; credits?: number; accounts: number } | 'error' | undefined;

/** Real bridge/Flow state, so "why is nothing rendering?" has an answer on every page. */
function BridgeStatus() {
  const { user, fetchImpl } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [info, setInfo] = useState<BridgeInfo>();
  useEffect(() => {
    if (!user.isAdmin) return;
    let alive = true;
    const load = () => requestJson<{ accounts: Array<{ credits?: number; enabled?: boolean }>; bridge: { online: boolean } }>(fetchImpl, '/api/flow/accounts')
      .then(r => {
        const accounts = Array.isArray(r?.accounts) ? r.accounts : [];
        if (alive) setInfo({
          online: !!r?.bridge?.online,
          accounts: accounts.length,
          ...(accounts.some(a => typeof a.credits === 'number') ? { credits: accounts.filter(a => a.enabled !== false).reduce((t, a) => t + (a.credits ?? 0), 0) } : {})
        });
      }, () => alive && setInfo('error'));
    void load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [user.isAdmin, fetchImpl]);
  if (!user.isAdmin || info === undefined) return null;
  const text = info === 'error' ? 'Status bridge tidak terbaca'
    : !info.online ? 'Bridge offline · render menunggu Mac'
    : `Bridge online${info.credits !== undefined ? ` · ${info.credits} kredit` : ''}`;
  const dot = info === 'error' ? 'bg-muted-foreground' : info.online ? 'bg-(--success)' : 'bg-destructive';
  return (
    <button type="button" role="status" aria-label={`Bridge: ${text}`} onClick={() => navigate('/pengaturan/flow', { state: { background: location } })}
      className={cn(rowClass, 'h-7 text-xs text-muted-foreground')}>
      <i aria-hidden="true" className={cn('ml-1 size-1.5 shrink-0 rounded-full', dot)} /> <span className="truncate">{text}</span>
    </button>
  );
}

function AccountMenu() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const open = (tab: string) => navigate(`/pengaturan/${tab}`, { state: { background: (location.state as { background?: unknown } | null)?.background ?? location } });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Akun" className={cn(rowClass, 'h-11 gap-2.5 px-2 aria-expanded:bg-accent')}>
        <span aria-hidden="true" className="glass-chosen flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{user.email.slice(0, 1).toUpperCase()}</span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] text-foreground">{user.email.split('@')[0]}</span>
          <span className="truncate text-[11px] text-muted-foreground">{user.isAdmin ? 'Admin workspace' : 'Anggota'}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => open('umum')}><Settings /> Pengaturan</DropdownMenuItem>
        {user.isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => open('anggota')}><Users /> Anggota &amp; undangan</DropdownMenuItem>
              <DropdownMenuItem onClick={() => open('penggunaan')}><Gauge /> Penggunaan</DropdownMenuItem>
              <DropdownMenuItem onClick={() => open('flow')}><Server /> Akun Flow</DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}><LogOut /> Keluar</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { stories } = useHistory();
  const [q, setQ] = useState('');
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (stories ?? []).filter(s => !needle || s.title.toLowerCase().includes(needle)).slice(0, 20);
  }, [stories, q]);
  return (
    <Dialog open={props.open} onOpenChange={o => { props.onOpenChange(o); if (!o) setQ(''); }}>
      <DialogContent className="top-[18%] translate-y-0 gap-0 p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Cari cerita</DialogTitle>
        <label className="flex h-12 items-center gap-2.5 border-b px-4 [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Search aria-hidden="true" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Cari judul cerita…" aria-label="Kata kunci"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </label>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {found.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{stories ? 'Tidak ada cerita yang cocok.' : 'Memuat…'}</li>
          ) : found.map(s => (
            <li key={s.id}>
              <NavLink to={`/cerita/${s.id}`} onClick={() => props.onOpenChange(false)} className={cn(rowClass, 'h-9')}>
                <i aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', storyDot(s))} />
                <span className="truncate">{s.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[s.status] ?? s.status}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

const wide = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 48rem)').matches;

export function Layout(props: { title: string; actions?: ReactNode; children: ReactNode; bare?: boolean }) {
  const [open, setOpen] = useState(wide);
  const [searching, setSearching] = useState(false);
  const location = useLocation();
  const drawer = open && !wide();
  const pick = () => { if (!wide()) setOpen(false); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (!wide()) setOpen(false); }, [location.pathname]);

  return (
    <div className="flex h-svh overflow-hidden bg-background text-[13px] text-foreground">
      {drawer && <button type="button" aria-label="Tutup menu" onClick={() => setOpen(false)} className="fixed inset-0 z-20 bg-black/50 md:hidden" />}
      {open && (
        <aside className={cn('flex w-[248px] shrink-0 flex-col border-r bg-sidebar', drawer && 'fixed inset-y-0 left-0 z-30 w-[280px] max-w-[85vw] bg-(--popover)')}>
          <div className="flex h-12 items-center gap-2 pr-2 pl-3">
            <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-[7px] bg-(--brand) text-[11px] font-bold text-(--brand-foreground)">N</span>
            <span className="text-sm font-medium">Creator</span>
            <IconButton label="Tutup sidebar" className="ml-auto" onClick={() => setOpen(false)}><PanelLeft /></IconButton>
          </div>
          <nav aria-label="Menu utama" className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-col gap-px px-1.5">
              <SideLink to="/" end icon={SquarePen} onPick={pick}>Buat baru</SideLink>
              <button type="button" className={rowClass} onClick={() => setSearching(true)} aria-label="Cari cerita">
                <Search aria-hidden="true" /> <span>Cari cerita</span>
                <span className="ml-auto hidden gap-0.5 md:flex"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
              </button>
              <div className="h-2" />
              {TOOLS.map(item => <SideLink key={item.to} to={item.to} icon={item.icon} onPick={pick}>{item.label}</SideLink>)}
            </div>
            <History onPick={pick} />
          </nav>
          <div className="flex flex-col gap-0.5 border-t px-1.5 py-1.5">
            <BridgeStatus />
            <AccountMenu />
          </div>
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-3">
          {(!open || drawer) && <IconButton label="Buka sidebar" onClick={() => setOpen(true)}><PanelLeft /></IconButton>}
          {props.title && <h1 className="min-w-0 truncate px-1 text-sm font-medium">{props.title}</h1>}
          <div className="ml-auto flex items-center gap-1.5">{props.actions}</div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          <div className={props.bare ? 'h-full' : 'content mx-auto px-4 pt-2 pb-8 md:px-6'}>{props.children}</div>
        </div>
      </main>
      <SearchDialog open={searching} onOpenChange={setSearching} />
    </div>
  );
}

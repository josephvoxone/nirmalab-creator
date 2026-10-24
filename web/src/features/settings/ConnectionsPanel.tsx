/**
 * Settings → Koneksi: the accounts Publish can post to. One row per platform with its
 * status and the one action that changes it (admins only). The OAuth callback lands
 * back here with ?connected=PLATFORM or ?platform=PLATFORM&error=MESSAGE.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { describeError, LoadingState } from '../../ui/states.js';
import {
  connectionState, missingAppText, PLATFORM_HINT, PLATFORM_LABEL, PLATFORMS, publishApi,
  type ConnectionState, type Platform, type PublisherStatus
} from '../publish/publishClient.js';

const BADGE_TONE: Record<ConnectionState['kind'], string> = {
  connected: 'text-(--success)',
  reconnect: 'text-destructive',
  disconnected: 'text-muted-foreground',
  unconfigured: 'text-muted-foreground'
};

function useCallbackNotice(): { tone: 'ok' | 'error'; text: string } | undefined {
  const { search } = useLocation();
  return useMemo(() => {
    const q = new URLSearchParams(search);
    const connected = q.get('connected') as Platform | null;
    if (connected && PLATFORMS.includes(connected)) return { tone: 'ok', text: `${PLATFORM_LABEL[connected]} berhasil terhubung.` };
    const error = q.get('error');
    if (error) {
      const p = q.get('platform') as Platform | null;
      const who = p && PLATFORMS.includes(p) ? PLATFORM_LABEL[p] : 'Platform';
      return { tone: 'error', text: `${who} gagal terhubung. ${error.slice(0, 300)}` };
    }
    return undefined;
  }, [search]);
}

function Row(props: { status: PublisherStatus; canEdit: boolean; busy: boolean; onConnect: () => void; onDisconnect: () => void }) {
  const s = props.status;
  const state = connectionState(s);
  const label = PLATFORM_LABEL[s.platform];
  let action: ReactNode = null;
  if (props.canEdit && state.kind === 'connected') {
    action = <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onDisconnect}>Putuskan</Button>;
  } else if (props.canEdit && state.kind !== 'unconfigured') {
    action = <Button size="sm" variant="glass" data-strong="" disabled={props.busy} onClick={props.onConnect}>{props.busy ? 'Membuka…' : 'Hubungkan'}</Button>;
  }
  return (
    <li aria-label={label} className="flex items-center gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-foreground">{label}</span>
          <Badge variant="secondary" className={cn('h-4.5 px-1.5 text-[11px] font-normal', BADGE_TONE[state.kind])}>{state.label}</Badge>
        </div>
        <span className="text-[12px] text-muted-foreground">
          {state.kind === 'unconfigured' ? missingAppText(s)
            : state.kind === 'reconnect' ? `Sesi ${label} habis. Hubungkan lagi agar Publish bisa mengirim.`
            : PLATFORM_HINT[s.platform]}
        </span>
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </li>
  );
}

export function ConnectionsPanel(props: { openUrl?: (url: string) => void }) {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => publishApi(fetchImpl), [fetchImpl]);
  const openUrl = props.openUrl ?? ((url: string) => window.location.assign(url));
  const callbackNotice = useCallbackNotice();
  const [noticeHidden, setNoticeHidden] = useState(false);
  const [statuses, setStatuses] = useState<PublisherStatus[]>();
  const [loadError, setLoadError] = useState<unknown>();
  const [busy, setBusy] = useState<Platform>();
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState<PublisherStatus>();

  const load = useCallback(async () => {
    setLoadError(undefined);
    try { setStatuses(await api.status()); } catch (e) { setLoadError(e); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const connect = async (p: Platform) => {
    setBusy(p);
    setActionError('');
    try { openUrl((await api.connect(p)).url); } catch (e) { setActionError(`${PLATFORM_LABEL[p]} tidak bisa dihubungkan. ${describeError(e)}`); } finally { setBusy(undefined); }
  };
  const disconnect = async (p: Platform) => {
    setConfirm(undefined);
    setBusy(p);
    setActionError('');
    try { await api.disconnect(p); await load(); } catch (e) { setActionError(`${PLATFORM_LABEL[p]} gagal diputuskan. ${describeError(e)}`); } finally { setBusy(undefined); }
  };

  return (
    <section aria-labelledby="set-connections" className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id="set-connections" className="text-[14px] font-medium text-foreground">Koneksi platform</h2>
        <p className="text-[12.5px] text-muted-foreground">Akun tujuan Publish. Video hanya bisa dikirim ke platform yang terhubung di sini.</p>
      </div>

      {callbackNotice && !noticeHidden && (
        callbackNotice.tone === 'ok' ? (
          <div role="status" aria-label="Hasil koneksi" className="flex items-center gap-2 rounded-md bg-(--success)/10 px-3 py-2 text-[12.5px] text-(--success)">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{callbackNotice.text}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Tutup pemberitahuan" onClick={() => setNoticeHidden(true)}><X /></Button>
          </div>
        ) : (
          <div role="alert" aria-label="Hasil koneksi" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            <span className="min-w-0 flex-1">{callbackNotice.text}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Tutup pemberitahuan" onClick={() => setNoticeHidden(true)}><X /></Button>
          </div>
        )
      )}

      {!user.isAdmin && <p className="text-[12.5px] text-muted-foreground">Hanya admin yang bisa menghubungkan atau memutuskan platform.</p>}
      {actionError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{actionError}</p>}

      {loadError && !statuses ? (
        <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">Status koneksi gagal dimuat. {describeError(loadError)}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}><RotateCcw /> Coba lagi</Button>
        </div>
      ) : !statuses ? (
        <LoadingState label="Memuat koneksi" className="flex flex-col gap-2">
          {PLATFORMS.map(p => <Skeleton key={p} className="h-11 w-full rounded-md" />)}
        </LoadingState>
      ) : (
        <ul aria-label="Platform" className="flex flex-col">
          {statuses.map(s => (
            <Row key={s.platform} status={s} canEdit={user.isAdmin} busy={busy === s.platform}
              onConnect={() => void connect(s.platform)} onDisconnect={() => setConfirm(s)} />
          ))}
        </ul>
      )}

      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Putuskan {confirm ? PLATFORM_LABEL[confirm.platform] : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.accountLabel ? `Akun ${confirm.accountLabel} dilepas dari Nirmalab Creator. ` : ''}
              Publish tidak bisa mengirim ke platform ini sampai dihubungkan lagi. Video yang sudah terkirim tidak terhapus.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Batal</AlertDialogCancel>
            <AlertDialogAction size="sm" variant="destructive" onClick={() => { if (confirm) void disconnect(confirm.platform); }}>
              Putuskan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

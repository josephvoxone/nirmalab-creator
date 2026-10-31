/**
 * The three non-happy states every screen needs (antislop R-27): loading says what is
 * loading, empty says why and offers the one action that fills it, error says what
 * failed in plain Indonesian and how to recover.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { ApiError } from '../lib/api.js';
import './states.css';

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Sesi berakhir. Silakan masuk lagi.';
    if (error.code === 'VIEWER_READ_ONLY') return 'Kamu Penonton di workspace ini, jadi tidak bisa mengubah proyek. Minta Pemilik menaikkan peranmu ke Editor.';
    if (error.status === 403) return 'Kamu tidak punya izin untuk tindakan ini di workspace ini.';
    if (error.status === 404) return 'Tidak ditemukan. Mungkin sudah dihapus, atau kamu bukan anggota workspace ini.';
    if (error.status === 409) return error.message;
    if (error.status >= 500) return `Server sedang bermasalah: ${error.message}. Coba lagi sebentar.`;
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/failed to fetch|fetch failed|network|load failed/i.test(message)) return 'Tidak ada koneksi ke server. Periksa internet lalu coba lagi.';
  return message || 'Terjadi kesalahan yang tidak dikenal.';
}

export function Skel(props: { w?: number | string; h?: number | string; className?: string }) {
  return <span className={`skel ${props.className ?? ''}`} style={{ width: props.w, height: props.h }} aria-hidden="true" />;
}

export function LoadingState(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={props.label} className={props.className}>
      {props.children}
    </div>
  );
}

export function EmptyState(props: { title: string; reason: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state-empty">
      {props.icon && <span className="state-icon" aria-hidden="true">{props.icon}</span>}
      <h3>{props.title}</h3>
      <p>{props.reason}</p>
      {props.action && <div className="state-action">{props.action}</div>}
    </div>
  );
}

export function ErrorState(props: { title: string; error: unknown; onRetry?: () => void; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`state-error${props.compact ? ' compact' : ''}`} role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <h3>{props.title}</h3>
        <p>{describeError(props.error)}</p>
        {(props.onRetry || props.action) && (
          <div className="state-action">
            {props.onRetry && <button type="button" className="btn btn-sm" onClick={props.onRetry}><RotateCcw size={14} /> Coba lagi</button>}
            {props.action}
          </div>
        )}
      </div>
    </div>
  );
}

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.js';
import { SessionContext } from '../lib/session.js';
import { Layout } from '../shell/Layout.js';
import { EmptyState, ErrorState, LoadingState, describeError } from './states.js';

describe('shared states', () => {
  it('loading says what is loading and is announced as busy', () => {
    render(<LoadingState label="Memuat template"><div className="skel" /></LoadingState>);
    const s = screen.getByRole('status', { name: 'Memuat template' });
    expect(s.getAttribute('aria-busy')).toBe('true');
  });

  it('empty state names the reason and offers the one action', async () => {
    const go = vi.fn();
    render(<EmptyState title="Belum ada cerita" reason="Cerita muncul di sini setelah kamu menulis storyboard." action={<button onClick={go}>Pilih template</button>} />);
    expect(screen.getByRole('heading', { name: 'Belum ada cerita' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Pilih template' }));
    expect(go).toHaveBeenCalled();
  });

  it('error state explains the failure and retries', async () => {
    const retry = vi.fn();
    render(<ErrorState title="Gagal memuat cerita" error={new Error('fetch failed')} onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Gagal memuat cerita/);
    expect(alert.textContent).toMatch(/koneksi/i);
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('describeError maps causes to human Indonesian with the next step', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/koneksi/i);
    expect(describeError(new ApiError(401, 'Unauthorized', 'UNAUTHORIZED'))).toMatch(/masuk lagi/i);
    expect(describeError(new ApiError(403, 'Forbidden', 'FORBIDDEN'))).toMatch(/izin/i);
    expect(describeError(new ApiError(403, 'Penonton tidak bisa mengubah', 'VIEWER_READ_ONLY'))).toMatch(/Penonton/i);
    expect(describeError(new ApiError(404, 'Story not found', 'NOT_FOUND'))).toMatch(/tidak ditemukan/i);
    expect(describeError(new ApiError(503, 'Pollinations down', 'STORY_FAILED'))).toMatch(/Pollinations down/);
  });
});

describe('navigation', () => {
  const mountLayout = (fetchImpl: ReturnType<typeof vi.fn>, isAdmin = true) => render(
    <SessionContext.Provider value={{ user: { id: 'u', email: 'a@x.io', isAdmin }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={['/cerita']}><Layout title="Cerita"><p>isi</p></Layout></MemoryRouter>
    </SessionContext.Provider>
  );

  it('lists new, search and every tool in the sidebar, the open page highlighted', () => {
    mountLayout(vi.fn(async () => new Response('{}', { status: 404 })));
    const nav = screen.getByRole('navigation', { name: 'Menu utama' });
    for (const name of [/Buat baru/, /Template/, /Proyek/, /Studio/, /Naskah & suara/, /Publish/]) expect(within(nav).getByRole('link', { name })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /Cari cerita/ })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /Proyek/ }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the real bridge state and credits (from /api/quota) above the account menu', async () => {
    const fetchImpl = vi.fn(async (url: string) => url === '/api/quota'
      ? new Response(JSON.stringify({ flow: { credits: 3, usedToday: 0, capToday: null, accounts: 1, online: true }, openrouter: { configured: false, remainingUsd: null, usedUsd: null }, storage: { usedBytes: 0, diskFreeBytes: null } }), { status: 200 })
      : new Response('{}', { status: 404 }));
    mountLayout(fetchImpl);
    const quota = await screen.findByRole('region', { name: /kuota/i });
    await waitFor(() => expect(quota.textContent).toMatch(/online.*3 kredit/i));
  });

  it('bridge offline is stated, not hidden (even from a reply missing fields)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accounts: [], bridge: { online: false } }), { status: 200 }));
    mountLayout(fetchImpl);
    expect(await screen.findByText(/flow offline/i)).toBeTruthy();
  });
});

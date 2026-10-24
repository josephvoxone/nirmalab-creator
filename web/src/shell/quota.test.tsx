import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { SessionContext } from '../lib/session.js';
import { admin, fail, fakeFetch, member, ok } from '../test/fake.js';
import { SidebarQuota, formatBytes } from './Quota.js';

const QUOTA = {
  flow: { credits: 1240, usedToday: 30, capToday: 100, accounts: 2, online: true },
  openrouter: { configured: true, remainingUsd: 4.2, usedUsd: 0.8 },
  storage: { usedBytes: 3.2 * 1024 ** 3, diskFreeBytes: 41 * 1024 ** 3 }
};

describe('refresh keeps the app shell', () => {
  it('while /api/auth/me is pending, the sidebar nav is there and the content area shows a labelled skeleton', async () => {
    const fetchImpl = vi.fn((url: string) => (url === '/api/auth/me' ? new Promise<Response>(() => undefined) : Promise.resolve(new Response('{}', { status: 404 }))));
    render(<App fetchImpl={fetchImpl} initialPath="/cerita" />);
    const nav = screen.getByRole('navigation', { name: /menu utama/i });
    expect(within(nav).getByRole('link', { name: /buat baru/i })).toHaveAttribute('href', '/');
    for (const label of ['Template', 'Proyek', 'Studio', 'Naskah & suara', 'Publish']) expect(within(nav).getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('status', { name: /memuat halaman/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/memuat akun/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/memuat riwayat/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Proyek' })).toBeInTheDocument();
  });

  it('without a session the login page has no sidebar', async () => {
    render(<App fetchImpl={fakeFetch(url => (url === '/api/auth/me' ? fail(401, 'Unauthorized') : undefined))} initialPath="/cerita" />);
    expect(await screen.findByRole('heading', { name: /masuk/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /menu utama/i })).toBeNull();
  });
});

function mountQuota(reply: () => { status: number; body: unknown } | Promise<never>, user = admin) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url !== '/api/quota') return new Response('{}', { status: 404 });
    const r = await reply();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  render(
    <SessionContext.Provider value={{ user, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SidebarQuota /></MemoryRouter>
    </SessionContext.Provider>
  );
  return fetchImpl;
}

const quotaCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(c => c[0] === '/api/quota').length;

describe('sidebar quota', () => {
  afterEach(() => vi.useRealTimers());

  it('shows Flow credits with today used/cap, OpenRouter remaining and storage used + free', async () => {
    mountQuota(() => ok(QUOTA));
    const box = await screen.findByRole('region', { name: /kuota/i });
    await waitFor(() => expect(box).toHaveTextContent('1.240 kredit'));
    const bar = within(box).getByRole('progressbar', { name: /kredit flow hari ini/i });
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(box).toHaveTextContent('30/100');
    expect(box).toHaveTextContent('$4.20');
    expect(box).toHaveTextContent('3,2 GB');
    expect(box).toHaveTextContent('41 GB kosong');
    expect(within(box).getByText(/online/i)).toBeInTheDocument();
  });

  it('hides OpenRouter when it is not configured, and the bar when there is no daily cap', async () => {
    mountQuota(() => ok({ ...QUOTA, flow: { ...QUOTA.flow, capToday: null }, openrouter: { configured: false, remainingUsd: null, usedUsd: null }, storage: { usedBytes: 1024, diskFreeBytes: null } }));
    const box = await screen.findByRole('region', { name: /kuota/i });
    await waitFor(() => expect(box).toHaveTextContent('1.240 kredit'));
    expect(box).not.toHaveTextContent(/openrouter/i);
    expect(within(box).queryByRole('progressbar')).toBeNull();
    expect(box).toHaveTextContent(/30 terpakai hari ini/i);
    expect(box).not.toHaveTextContent(/kosong/i);
  });

  it('says the bridge is offline', async () => {
    mountQuota(() => ok({ ...QUOTA, flow: { ...QUOTA.flow, online: false } }));
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
  });

  it('shows a labelled skeleton while loading', () => {
    mountQuota(() => new Promise<never>(() => undefined));
    expect(screen.getByRole('status', { name: /memuat kuota/i })).toBeInTheDocument();
  });

  it('a failed load is a quiet one-liner with retry; a failed refresh keeps the numbers', async () => {
    let broken = true;
    mountQuota(() => (broken ? fail(500, 'boom') : ok(QUOTA)));
    const retry = await screen.findByRole('button', { name: /muat ulang kuota/i });
    expect(screen.getByRole('region', { name: /kuota/i })).toHaveTextContent(/kuota tidak terbaca/i);
    broken = false;
    await userEvent.click(retry);
    expect(await screen.findByText('1.240 kredit')).toBeInTheDocument();
  });

  it('refreshes every 60 s and keeps the content when a refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const f = mountQuota(() => (++n > 1 ? fail(500, 'boom') : ok(QUOTA)));
    await screen.findByText('1.240 kredit');
    expect(quotaCalls(f)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(quotaCalls(f)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(quotaCalls(f)).toBe(2);
    expect(await screen.findByText(/gagal diperbarui/i)).toBeInTheDocument();
    expect(screen.getByText('1.240 kredit')).toBeInTheDocument();
  });

  it('members see it too (it is not admin-only)', async () => {
    mountQuota(() => ok(QUOTA), member);
    expect(await screen.findByText('1.240 kredit')).toBeInTheDocument();
  });

  it('formats bytes in Indonesian', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536 * 1024)).toBe('1,5 MB');
    expect(formatBytes(41 * 1024 ** 3)).toBe('41 GB');
  });
});

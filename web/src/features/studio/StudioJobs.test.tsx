import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { flowClient } from './flowClient.js';
import { StudioPage } from './StudioPage.js';

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
const account = { id: 'acc_1', label: 'Akun 1', email: 'a@b.c', status: 'ready', creditsUsedToday: 2, credits: 103 };
const mine = { id: 'job_aaaaaaaaaaaaaaaa', prompt: 'ombak milikku', status: 'done', aspect: '9:16', durationSec: 4, attempts: 0, createdAtMs: 1, accountId: 'acc_1' };

function renderPage(fetchImpl: ReturnType<typeof vi.fn>) {
  render(
    <MemoryRouter initialEntries={['/studio']}>
      <Routes>
        <Route path="/studio" element={<StudioPage baseUrl="" fetchImpl={fetchImpl as unknown as typeof fetch} techniques={[]} />} />
        <Route path="/pengaturan/:tab" element={<p>Pengaturan</p>} />
      </Routes>
    </MemoryRouter>
  );
}
const openResults = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /lihat hasil/i }));

describe('Studio memakai daftar milik sendiri (T4)', () => {
  it('memuat daftar dari GET /api/flow/jobs (bukan rute admin) dan tidak pernah meminta rute admin', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { online: true } });
      if (url.endsWith('/api/flow/jobs')) return json({ jobs: [mine] });
      return json({}, 404);
    });
    renderPage(fetchImpl);
    await screen.findByText(/bridge online/i);
    await openResults(user);
    expect(screen.getByRole('listitem', { name: /ombak milikku/ })).toBeTruthy();
    const urls = fetchImpl.mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/api/flow/jobs');
    expect(urls.some(u => u.includes('/api/admin/'))).toBe(false);
  });

  it('pengguna non-admin: akun Flow ditolak (403) tetapi hasil miliknya tetap tampil, tanpa pesan galat dan tanpa tombol Kelola akun Flow', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/flow/accounts')) return json({ error: { code: 'FORBIDDEN', message: 'Admin only' } }, 403);
      if (url.endsWith('/api/flow/jobs')) return json({ jobs: [mine] });
      return json({}, 404);
    });
    renderPage(fetchImpl);
    await waitFor(() => expect(screen.getByRole('button', { name: /lihat hasil \(1\)/i })).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/bridge (online|offline)/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /kelola akun flow/i })).toBeNull();
    await openResults(user);
    expect(screen.getByRole('listitem', { name: /ombak milikku/ })).toBeTruthy();
  });

  it('keadaan memuat: kerangka dengan label sampai daftar tiba', async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith('/api/flow/accounts')) return Promise.resolve(json({ accounts: [account], bridge: { online: true } }));
      if (url.endsWith('/api/flow/jobs')) return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(json({}, 404));
    });
    renderPage(fetchImpl);
    await waitFor(() => expect(screen.getByRole('button', { name: /lihat hasil/i })).toBeTruthy());
    await openResults(user);
    expect(screen.getByRole('status', { name: /memuat antrean/i })).toBeTruthy();
    release(json({ jobs: [mine] }));
    await screen.findByRole('listitem', { name: /ombak milikku/ });
  });

  it('keadaan kosong: menjelaskan bahwa daftar ini hanya berisi hasil milikmu dan memberi satu aksi', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { online: true } });
      if (url.endsWith('/api/flow/jobs')) return json({ jobs: [] });
      return json({}, 404);
    });
    renderPage(fetchImpl);
    await screen.findByText(/bridge online/i);
    await openResults(user);
    expect(screen.getByText(/belum ada hasil/i)).toBeTruthy();
    expect(screen.getByText(/hanya.*milikmu/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /buat yang pertama/i })).toBeTruthy();
  });

  it('keadaan galat: daftar gagal dimuat menampilkan sebab dan Coba lagi memuat ulang; status Flow tetap tampil', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { online: true } });
      if (url.endsWith('/api/flow/jobs')) {
        calls += 1;
        return calls === 1 ? json({ error: { message: 'database sedang restart' } }, 500) : json({ jobs: [mine] });
      }
      return json({}, 404);
    });
    renderPage(fetchImpl);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('database sedang restart');
    expect(alert).toHaveTextContent(/hasilmu belum termuat/i);
    await screen.findByText(/bridge online/i);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await openResults(user);
    expect(screen.getByRole('listitem', { name: /ombak milikku/ })).toBeTruthy();
  });
});

describe('flowClient: rute daftar', () => {
  it('jobs() = daftar milik sendiri; adminJobs() = rute admin tersensor', async () => {
    const calls: string[] = [];
    const api = flowClient('', async url => { calls.push(url); return json({ jobs: [] }); });
    await api.jobs();
    await api.adminJobs();
    expect(calls).toEqual(['/api/flow/jobs', '/api/admin/flow/jobs']);
  });
});

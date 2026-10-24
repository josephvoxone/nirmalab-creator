import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../lib/session.js';
import type { User } from '../lib/api.js';
import { StudioPage } from './studio/StudioPage.js';
import PublishPage from './publish/PublishPage.js';
import SettingsPage from './settings/SettingsPage.js';

const admin: User = { id: 'u1', email: 'a@x.io', isAdmin: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function withSession(node: React.ReactNode, fetchImpl: ReturnType<typeof vi.fn>) {
  return render(
    <SessionContext.Provider value={{ user: admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter>{node}</MemoryRouter>
    </SessionContext.Provider>
  );
}

describe('Studio states', () => {
  it('first load failure is an error with retry, then recovers', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (fail) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/flow/accounts')) return json({ accounts: [], bridge: { online: false } });
      return json({ jobs: [] });
    });
    render(<StudioPage baseUrl="" fetchImpl={fetchImpl as unknown as typeof fetch} techniques={[]} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Gagal memuat antrean Flow/);
    expect(alert.textContent).toMatch(/koneksi/i);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('heading', { name: 'Antrean kosong' })).toBeTruthy();
  });

  it('shows a skeleton until the queue arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      await gate;
      return url.endsWith('/api/flow/accounts') ? json({ accounts: [], bridge: { online: true } }) : json({ jobs: [] });
    });
    render(<StudioPage baseUrl="" fetchImpl={fetchImpl as unknown as typeof fetch} techniques={[]} />);
    expect(screen.getByRole('status', { name: 'Memuat antrean' })).toBeTruthy();
    release();
    expect(await screen.findByRole('heading', { name: 'Antrean kosong' })).toBeTruthy();
  });
});

describe('Publish states', () => {
  it('platforms skeleton while loading; no finished story → empty state linking to Cerita', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      await gate;
      if (url.includes('status')) return json({ publishers: [] });
      if (url.includes('/api/stories')) return json({ stories: [] });
      return json({ jobs: [], statuses: [] });
    });
    withSession(<PublishPage />, fetchImpl);
    expect(screen.getByRole('status', { name: 'Memuat platform' })).toBeTruthy();
    release();
    const empty = await screen.findByRole('heading', { name: 'Belum ada video untuk dipublish' });
    const box = empty.closest('.state-empty') as HTMLElement;
    expect(within(box).getByRole('link', { name: /Buka Cerita/ }).getAttribute('href')).toBe('/cerita');
  });
});

describe('Settings states', () => {
  it('no Flow account yet → empty state that says what to add', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/flow/accounts')) return json({ accounts: [], bridge: { online: false } });
      if (url.includes('/invites')) return json({ invites: [] });
      return json({});
    });
    withSession(<SettingsPage tab="flow" />, fetchImpl);
    expect(await screen.findByRole('heading', { name: 'Belum ada akun Flow' })).toBeTruthy();
  });
});

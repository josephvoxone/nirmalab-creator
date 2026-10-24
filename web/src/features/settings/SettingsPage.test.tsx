import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import SettingsPage, { type SettingsTab } from './SettingsPage.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin: User = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

function renderPage(fetchImpl: ReturnType<typeof fakeFetch>, user: User = admin, tab: SettingsTab = 'umum') {
  return render(
    <SessionContext.Provider value={{ user, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab={tab} /></MemoryRouter>
    </SessionContext.Provider>
  );
}

const flowBody = (accounts: unknown[] = [], bridge: unknown = { online: false }) => ({ accounts, bridge });

describe('SettingsPage · Undang anggota', () => {
  it('creates an invite, shows the join link and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let invites: unknown[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/invites' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ email: 'baru@nirmalab.com' });
        invites = [{ tokenHash: HASH_A, email: 'baru@nirmalab.com', createdAt: new Date().toISOString(), expiresAt: future, createdBy: 'u1' }];
        return { status: 200, body: { token: 'tok_newinvite123', expiresAt: future, email: 'baru@nirmalab.com' } };
      }
      if (url === '/api/auth/invites') return { status: 200, body: { invites } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody() };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'anggota');
    const card = screen.getByRole('region', { name: /undang anggota/i });
    await userEvent.type(within(card).getByLabelText(/email/i), 'baru@nirmalab.com');
    await userEvent.click(within(card).getByRole('button', { name: /buat undangan/i }));
    const link = `${window.location.origin}/join/tok_newinvite123`;
    expect(await within(card).findByText(link)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /salin/i }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await within(card).findByRole('listitem', { name: 'baru@nirmalab.com' })).toHaveTextContent('Aktif');
  });

  it('lists invites with their state and revokes an active one', async () => {
    let revoked = false;
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/invites/revoke' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ tokenHash: HASH_A });
        revoked = true;
        return { status: 200, body: { ok: true } };
      }
      if (url === '/api/auth/invites') {
        return { status: 200, body: { invites: [
          ...(revoked ? [] : [{ tokenHash: HASH_A, email: 'a@x.io', createdAt: past, expiresAt: future, createdBy: 'u1' }]),
          { tokenHash: HASH_B, createdAt: past, expiresAt: future, usedAt: past, createdBy: 'u1' },
          { tokenHash: 'c'.repeat(64), email: 'lama@x.io', createdAt: past, expiresAt: past, createdBy: 'u1' }
        ] } };
      }
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody() };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'anggota');
    const card = screen.getByRole('region', { name: /undang anggota/i });
    const active = await within(card).findByRole('listitem', { name: 'a@x.io' });
    expect(active).toHaveTextContent('Aktif');
    expect(within(card).getByRole('listitem', { name: 'Siapa saja' })).toHaveTextContent('Dipakai');
    const expired = within(card).getByRole('listitem', { name: 'lama@x.io' });
    expect(expired).toHaveTextContent('Kedaluwarsa');
    expect(within(expired).queryByRole('button', { name: /cabut/i })).not.toBeInTheDocument();
    await userEvent.click(within(active).getByRole('button', { name: /cabut/i }));
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: 'a@x.io' })).not.toBeInTheDocument());
  });

  it('shows the server message when creating an invite fails', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/invites' && init?.method === 'POST') return { status: 400, body: { error: { code: 'INVALID_EMAIL', message: 'Valid email required' } } };
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody() };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'anggota');
    const card = screen.getByRole('region', { name: /undang anggota/i });
    await userEvent.click(within(card).getByRole('button', { name: /buat undangan/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Valid email required');
  });
});

describe('SettingsPage · Akun Flow & bridge', () => {
  it('shows the bridge state, credits per account and the total', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody([
        { id: 'acc1', label: 'Utama', email: 'flow1@x.io', status: 'ready', credits: 120, creditsUsedToday: 40 },
        { id: 'acc2', label: 'Cadangan', email: 'flow2@x.io', status: 'error', credits: 30, creditsUsedToday: 0, lastError: 'Login kedaluwarsa' },
        { id: 'acc3', label: 'Baru', email: 'flow3@x.io', status: 'ready', creditsUsedToday: 0 }
      ], { online: true, lastSeenMs: Date.now() - 120_000, bridgeId: 'mac-mini' }) };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'flow');
    const card = screen.getByRole('region', { name: /akun flow/i });
    expect(await within(card).findByText('Online')).toBeInTheDocument();
    expect(within(card).getByText(/2 menit lalu/)).toBeInTheDocument();
    expect(within(card).getByText('mac-mini')).toBeInTheDocument();
    expect(within(card).getByTestId('credits-total')).toHaveTextContent('150');
    const utama = within(card).getByRole('listitem', { name: 'Utama' });
    expect(utama).toHaveTextContent('120 kredit');
    expect(utama).toHaveTextContent('40 kredit terpakai hari ini');
    expect(within(card).getByRole('listitem', { name: 'Cadangan' })).toHaveTextContent('Login kedaluwarsa');
    expect(within(card).getByRole('listitem', { name: 'Baru' })).toHaveTextContent('kredit belum diketahui');
  });

  it('shows the bridge offline', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody([], { online: false }) };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'flow');
    const card = screen.getByRole('region', { name: /akun flow/i });
    expect(await within(card).findByText('Offline')).toBeInTheDocument();
    expect(within(card).getByText(/belum pernah terhubung/i)).toBeInTheDocument();
  });

  it('adds an account and removes one after confirming', async () => {
    let accounts = [{ id: 'acc1', label: 'Utama', email: 'flow1@x.io', status: 'ready', credits: 100, creditsUsedToday: 0 }];
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ label: 'Kedua', email: 'flow2@x.io', profileDir: 'flow-2' });
        accounts = [...accounts, { id: 'acc2', label: 'Kedua', email: 'flow2@x.io', status: 'ready', credits: 0, creditsUsedToday: 0 }];
        return { status: 200, body: { account: accounts[1] } };
      }
      if (url === '/api/flow/accounts/acc1' && init?.method === 'DELETE') {
        accounts = accounts.filter(a => a.id !== 'acc1');
        return { status: 200, body: { ok: true } };
      }
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody(accounts) };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'flow');
    const card = screen.getByRole('region', { name: /akun flow/i });
    await within(card).findByRole('listitem', { name: 'Utama' });
    await userEvent.type(within(card).getByLabelText(/label/i), 'Kedua');
    await userEvent.type(within(card).getByLabelText(/email google/i), 'flow2@x.io');
    await userEvent.type(within(card).getByLabelText(/profil chrome/i), 'flow-2');
    await userEvent.click(within(card).getByRole('button', { name: /tambah akun/i }));
    expect(await within(card).findByRole('listitem', { name: 'Kedua' })).toBeInTheDocument();
    const utama = within(card).getByRole('listitem', { name: 'Utama' });
    await userEvent.click(within(utama).getByRole('button', { name: /hapus/i }));
    expect(fetchImpl.mock.calls.some(([u, i]) => u === '/api/flow/accounts/acc1' && i?.method === 'DELETE')).toBe(false);
    await userEvent.click(within(utama).getByRole('button', { name: /yakin/i }));
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: 'Utama' })).not.toBeInTheDocument());
  });

  it('shows the server message when adding an account fails', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts' && init?.method === 'POST') return { status: 409, body: { error: { code: 'INVALID_INPUT', message: 'duplicate email' } } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody() };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, admin, 'flow');
    const card = screen.getByRole('region', { name: /akun flow/i });
    await userEvent.type(within(card).getByLabelText(/label/i), 'X');
    await userEvent.click(within(card).getByRole('button', { name: /tambah akun/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('duplicate email');
  });
});

describe('SettingsPage · Ganti password', () => {
  function passwordFetch(reply: { status: number; body: unknown }) {
    return fakeFetch((url, init) => {
      if (url === '/api/auth/change-password' && init?.method === 'POST') return reply;
      if (url === '/api/auth/invites') return { status: 200, body: { invites: [] } };
      if (url === '/api/flow/accounts') return { status: 200, body: flowBody() };
      return { status: 404, body: {} };
    });
  }

  async function fill(card: HTMLElement, current: string, next: string, confirm: string) {
    await userEvent.type(within(card).getByLabelText(/password saat ini/i), current);
    await userEvent.type(within(card).getByLabelText(/^password baru$/i), next);
    await userEvent.type(within(card).getByLabelText(/ulangi password baru/i), confirm);
    await userEvent.click(within(card).getByRole('button', { name: /ganti password/i }));
  }

  it('changes the password and confirms it', async () => {
    const fetchImpl = passwordFetch({ status: 200, body: { ok: true } });
    renderPage(fetchImpl, admin, 'akun');
    const card = screen.getByRole('region', { name: /ganti password/i });
    await fill(card, 'old-pass-1', 'new-pass-12', 'new-pass-12');
    expect(await within(card).findByRole('status')).toHaveTextContent(/password diganti/i);
    const call = fetchImpl.mock.calls.find(([u]) => u === '/api/auth/change-password');
    expect(bodyOf(call?.[1])).toEqual({ currentPassword: 'old-pass-1', newPassword: 'new-pass-12' });
    expect(within(card).getByLabelText(/password saat ini/i)).toHaveValue('');
  });

  it('refuses a mismatched confirmation without calling the server', async () => {
    const fetchImpl = passwordFetch({ status: 200, body: { ok: true } });
    renderPage(fetchImpl, admin, 'akun');
    const card = screen.getByRole('region', { name: /ganti password/i });
    await fill(card, 'old-pass-1', 'new-pass-12', 'new-pass-13');
    expect(await within(card).findByRole('alert')).toHaveTextContent(/tidak sama/i);
    expect(fetchImpl.mock.calls.some(([u]) => u === '/api/auth/change-password')).toBe(false);
  });

  it('shows the server message when the current password is wrong', async () => {
    const fetchImpl = passwordFetch({ status: 400, body: { error: { code: 'WRONG_PASSWORD', message: 'Current password is wrong' } } });
    renderPage(fetchImpl, admin, 'akun');
    const card = screen.getByRole('region', { name: /ganti password/i });
    await fill(card, 'bad-pass-1', 'new-pass-12', 'new-pass-12');
    expect(await within(card).findByRole('alert')).toHaveTextContent('Current password is wrong');
  });
});

describe('SettingsPage · member', () => {
  it('a non-admin gets only the personal tabs, falls back from admin tabs, and loads no admin data', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 403, body: {} }));
    renderPage(fetchImpl, { ...admin, isAdmin: false }, 'anggota');
    const tabs = screen.getByRole('tablist', { name: /pengaturan/i });
    expect(within(tabs).getAllByRole('tab').map(t => t.textContent)).toEqual(['Umum', 'Akun']);
    expect(screen.getByRole('tab', { name: 'Umum' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: /undang anggota/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Akun' }));
    expect(screen.getByRole('region', { name: /ganti password/i })).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 20));
    expect(fetchImpl.mock.calls.map(([u]) => u).filter(u => /invites|flow|members/.test(String(u)))).toEqual([]);
  });
});

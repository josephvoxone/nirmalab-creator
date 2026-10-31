import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { SessionContext } from '../../lib/session.js';
import { admin, bodyOf, fail, fakeFetch, ok, STORIES, type Handler } from '../../test/fake.js';
import SettingsPage, { type SettingsTab } from './SettingsPage.js';

function page(handler: Handler, tab: SettingsTab) {
  const fetchImpl = fakeFetch(handler);
  render(
    <SessionContext.Provider value={{ user: admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab={tab} /></MemoryRouter>
    </SessionContext.Provider>
  );
  return fetchImpl;
}

const MEMBERS = [
  { id: 'u1', email: 'joseph@example.com', isAdmin: true, createdAt: '2026-10-01T00:00:00Z' },
  { id: 'u2', email: 'tim@example.com', isAdmin: false, createdAt: '2026-10-02T00:00:00Z', lastSeenAt: '2026-10-23T00:00:00Z' }
];

describe('Settings dialog route', () => {
  it('opens /pengaturan/penggunaan as a modal over the app, with tabs, and closes back home', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/auth/me') return ok({ user: admin });
      if (url === '/api/stories') return ok({ stories: STORIES });
      if (url.startsWith('/api/flow/usage')) return ok(usage(7));
      if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
      if (url === '/api/stories/catalog') return ok({ catalog: { templates: [] }, covers: {} });
      return undefined;
    });
    render(<App fetchImpl={fetchImpl} initialPath="/pengaturan/penggunaan" />);
    const dialog = await screen.findByRole('dialog', { name: /pengaturan/i });
    const tabs = within(dialog).getByRole('tablist', { name: /pengaturan/i });
    expect(within(tabs).getAllByRole('tab').map(t => t.textContent)).toEqual(['Umum', 'Akun', 'Anggota', 'Penggunaan', 'Penyimpanan', 'Akun Flow', 'Provider', 'Integrasi', 'Koneksi']);
    expect(within(dialog).getByRole('tab', { name: 'Penggunaan' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: /mau bikin video apa/i })).toBeInTheDocument();
  });
});

describe('Settings · Anggota', () => {
  it('lists members with role and last seen; changes a role; removes after confirming', async () => {
    let members = MEMBERS.map(m => ({ ...m }));
    const calls: Array<[string, string, unknown]> = [];
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members });
      const m = url.match(/^\/api\/auth\/members\/(\w+)$/);
      if (m && init?.method === 'PATCH') { calls.push(['PATCH', m[1]!, bodyOf(init)]); members = members.map(x => x.id === m[1] ? { ...x, ...bodyOf(init) } : x); return ok({ member: members.find(x => x.id === m[1]) }); }
      if (m && init?.method === 'DELETE') { calls.push(['DELETE', m[1]!, null]); members = members.filter(x => x.id !== m[1]); return ok({ ok: true }); }
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    const tim = await within(region).findByRole('listitem', { name: 'tim@example.com' });
    expect(tim).toHaveTextContent(/anggota/i);
    const me = within(region).getByRole('listitem', { name: 'joseph@example.com' });
    expect(me).toHaveTextContent(/kamu/i);
    expect(within(me).queryByRole('button', { name: /keluarkan/i })).not.toBeInTheDocument();
    await userEvent.click(within(tim).getByRole('button', { name: /jadikan admin/i }));
    await waitFor(() => expect(calls).toContainEqual(['PATCH', 'u2', { isAdmin: true }]));
    expect(await within(region).findByRole('listitem', { name: 'tim@example.com' })).toHaveTextContent(/admin/i);
    await userEvent.click(within(within(region).getByRole('listitem', { name: 'tim@example.com' })).getByRole('button', { name: /keluarkan/i }));
    await userEvent.click(await screen.findByRole('button', { name: /ya, keluarkan/i }));
    await waitFor(() => expect(within(region).queryByRole('listitem', { name: 'tim@example.com' })).not.toBeInTheDocument());
    expect(calls).toContainEqual(['DELETE', 'u2', null]);
  });

  it('shows why a member action is refused', async () => {
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members: MEMBERS });
      if (url === '/api/auth/members/u2') return fail(409, 'Tidak bisa menurunkan admin terakhir');
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@example.com' })).getByRole('button', { name: /jadikan admin/i }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(/admin terakhir/i);
  });

  it('shows an error with retry when the member list fails', async () => {
    let n = 0;
    page(url => {
      if (url === '/api/auth/members') return ++n === 1 ? fail(500, 'x') : ok({ members: MEMBERS });
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(await within(region).findByRole('button', { name: /coba lagi/i }));
    expect(await within(region).findByRole('listitem', { name: 'tim@example.com' })).toBeInTheDocument();
  });
});

function usage(days: number) {
  return {
    range: { from: '2026-10-18', to: '2026-10-24', days },
    totals: { jobs: 12, done: 9, failed: 2, running: 1, queued: 0, credits: 50 },
    byDay: Array.from({ length: days }, (_, i) => ({ date: `2026-10-${String(18 + (i % 7)).padStart(2, '0')}`, jobs: i, done: i, failed: 0, credits: i * 10 })),
    byAccount: [
      { accountId: 'a1', label: 'Utama', jobs: 8, done: 7, failed: 1, credits: 40, enabled: true, dailyCreditCap: 60, creditsUsedToday: 20, creditsRemaining: 3 },
      { accountId: 'a2', label: 'Cadangan', jobs: 4, done: 2, failed: 1, credits: 10, enabled: false, creditsUsedToday: 0 }
    ],
    byKind: { video: { jobs: 5, done: 5, credits: 50 }, image: { jobs: 6, done: 4, credits: 0 }, character: { jobs: 1, done: 0, credits: 0 } },
    byMember: [{ userId: 'u1', email: 'joseph@example.com', jobs: 10, done: 8, credits: 40 }, { userId: 'unknown', jobs: 2, done: 1, credits: 10 }]
  };
}

describe('Settings · Penggunaan', () => {
  it('shows totals, per account, per member and per kind, and switches the range', async () => {
    const asked: string[] = [];
    page(url => {
      if (url.startsWith('/api/flow/usage')) { asked.push(url); return ok(usage(url.includes('days=30') ? 30 : 7)); }
      return undefined;
    }, 'penggunaan');
    const region = await screen.findByRole('region', { name: /penggunaan/i });
    expect(await within(region).findByTestId('usage-credits')).toHaveTextContent('50');
    expect(within(region).getByTestId('usage-jobs')).toHaveTextContent('12');
    const accounts = within(region).getByRole('table', { name: /per akun flow/i });
    expect(within(accounts).getByRole('row', { name: /utama/i })).toHaveTextContent(/20 \/ 60/);
    expect(within(accounts).getByRole('row', { name: /cadangan/i })).toHaveTextContent(/nonaktif/i);
    const people = within(region).getByRole('table', { name: /per anggota/i });
    expect(within(people).getByRole('row', { name: /joseph@example.com/i })).toHaveTextContent('40');
    expect(within(people).getByRole('row', { name: /tanpa pemilik/i })).toBeInTheDocument();
    expect(within(region).getAllByTestId('usage-bar')).toHaveLength(7);
    await userEvent.click(within(region).getByRole('radio', { name: /30 hari/i }));
    await waitFor(() => expect(asked.at(-1)).toBe('/api/flow/usage?days=30'));
    await waitFor(() => expect(within(region).getAllByTestId('usage-bar')).toHaveLength(30));
  });

  it('shows the empty state when nothing ran yet', async () => {
    page(url => url.startsWith('/api/flow/usage') ? ok({ ...usage(7), totals: { jobs: 0, done: 0, failed: 0, running: 0, queued: 0, credits: 0 }, byAccount: [], byMember: [] }) : undefined, 'penggunaan');
    expect(await screen.findByText(/belum ada pemakaian/i)).toBeInTheDocument();
  });
});

describe('Settings · Akun Flow pool', () => {
  const ACCOUNTS = [
    { id: 'a1', label: 'Utama', email: 'f1@x.io', status: 'ready', creditsUsedToday: 20, dayStamp: '2026-10-24', createdAtMs: 1, credits: 3, enabled: true, priority: 0, dailyCreditCap: 60 },
    { id: 'a2', label: 'Cadangan', email: 'f2@x.io', status: 'ready', creditsUsedToday: 0, dayStamp: '2026-10-24', createdAtMs: 2, credits: 100, enabled: true, priority: 1 }
  ];
  function pool() {
    const calls: Array<[string, string, unknown]> = [];
    let accounts = ACCOUNTS.map(a => ({ ...a }));
    let rotation = 'least-used';
    page((url, init) => {
      if (url === '/api/flow/accounts' && !init?.method) return ok({ accounts, bridge: { online: true, lastSeenMs: Date.now() } });
      if (url === '/api/flow/pool' && !init?.method) return ok({ pool: { rotation } });
      if (url === '/api/flow/pool' && init?.method === 'PUT') { calls.push(['PUT', url, bodyOf(init)]); rotation = bodyOf(init).rotation; return ok({ pool: { rotation } }); }
      const m = url.match(/^\/api\/flow\/accounts\/(\w+)$/);
      if (m && init?.method === 'PATCH') { calls.push(['PATCH', m[1]!, bodyOf(init)]); accounts = accounts.map(a => a.id === m[1] ? { ...a, ...bodyOf(init) } : a); return ok({ account: accounts.find(a => a.id === m[1]) }); }
      return undefined;
    }, 'flow');
    return calls;
  }

  it('switches the rotation strategy', async () => {
    const calls = pool();
    const region = await screen.findByRole('region', { name: /rotasi akun/i });
    expect(await within(region).findByRole('radio', { name: /paling jarang dipakai/i })).toBeChecked();
    await userEvent.click(within(region).getByRole('radio', { name: /round-robin/i }));
    await waitFor(() => expect(calls).toContainEqual(['PUT', '/api/flow/pool', { rotation: 'round-robin' }]));
    expect(within(region).getByRole('radio', { name: /round-robin/i })).toBeChecked();
  });

  it('turns an account off, sets its daily cap and priority', async () => {
    const calls = pool();
    const region = await screen.findByRole('region', { name: /akun flow/i });
    const row = await within(region).findByRole('listitem', { name: 'Cadangan' });
    await userEvent.click(within(row).getByRole('switch', { name: /aktif/i }));
    await waitFor(() => expect(calls).toContainEqual(['PATCH', 'a2', { enabled: false }]));
    await userEvent.type(within(row).getByRole('spinbutton', { name: /batas kredit harian/i }), '40');
    await userEvent.tab();
    await waitFor(() => expect(calls).toContainEqual(['PATCH', 'a2', { dailyCreditCap: 40 }]));
    const prio = within(row).getByRole('spinbutton', { name: /prioritas/i });
    await userEvent.clear(prio);
    await userEvent.type(prio, '0');
    await userEvent.tab();
    await waitFor(() => expect(calls).toContainEqual(['PATCH', 'a2', { priority: 0 }]));
    const utama = within(region).getByRole('listitem', { name: 'Utama' });
    expect(utama).toHaveTextContent(/20 \/ 60 kredit hari ini/);
  });
});

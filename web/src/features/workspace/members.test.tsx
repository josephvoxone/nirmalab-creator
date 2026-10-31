import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { admin, bodyOf, fail, fakeFetch, ok, type Handler } from '../../test/fake.js';
import { SessionContext } from '../../lib/session.js';
import SettingsPage from '../settings/SettingsPage.js';
import { App } from '../../App.js';

type Role = 'owner' | 'editor' | 'viewer';
const NOW = Date.parse('2026-11-01T00:00:00Z');
const DAY = 86_400_000;

function harness(role: Role, opts: { failFirstRead?: boolean } = {}) {
  let members: Array<{ userId: string; email: string; role: Role; joinedAtMs: number }> = [
    { userId: 'u1', email: 'joseph@nirmalab.com', role: 'owner', joinedAtMs: NOW - 30 * DAY },
    { userId: 'u2', email: 'tim@nirmalab.com', role: 'editor', joinedAtMs: NOW - 10 * DAY }
  ];
  let invites = [{ id: 'inv_1', email: 'c@nirmalab.com', role: 'viewer' as Role, expiresAtMs: NOW + 5 * DAY }];
  const calls: Array<[string, string, unknown]> = [];
  let failList = opts.failFirstRead ? 1 : 0;
  const handler: Handler = (url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/workspaces') return ok({ workspaces: [{ id: 'w1', name: 'Ruang kerja Joseph', role, personal: true, projects: 2, members: members.length }] });
    if (url === '/api/workspaces/w1' && method === 'GET') {
      if (failList > 0) { failList -= 1; return fail(500, 'gagal membaca tenancy.json'); }
      return ok({ workspace: { id: 'w1', name: 'Ruang kerja Joseph', ownerId: 'u1', personal: true }, members, ...(role === 'owner' ? { invites } : {}) });
    }
    if (url === '/api/workspaces/w1/invites' && method === 'POST') {
      calls.push(['POST', 'invite', bodyOf(init)]);
      const body = bodyOf(init) as { email: string; role: Role };
      invites = [...invites, { id: 'inv_2', email: body.email, role: body.role, expiresAtMs: NOW + 7 * DAY }];
      return ok({ invite: { id: 'inv_2', email: body.email, role: body.role, expiresAtMs: NOW + 7 * DAY }, url: '/join/tok_new' });
    }
    if (url === '/api/workspaces/w1/invites/inv_1' && method === 'DELETE') {
      calls.push(['DELETE', 'invite', null]); invites = invites.filter(i => i.id !== 'inv_1'); return ok({ ok: true });
    }
    if (url === '/api/workspaces/w1/members/u2' && method === 'PATCH') {
      const body = bodyOf(init) as { role: Role };
      calls.push(['PATCH', 'member', body]);
      members = members.map(m => m.userId === 'u2' ? { ...m, role: body.role } : m);
      return ok({ member: members[1] });
    }
    if (url === '/api/workspaces/w1/members/u2' && method === 'DELETE') {
      calls.push(['DELETE', 'member', null]); members = members.filter(m => m.userId !== 'u2'); return ok({ ok: true });
    }
    return undefined;
  };
  const fetchImpl = fakeFetch(handler);
  render(
    <SessionContext.Provider value={{ user: admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab="anggota-workspace" /></MemoryRouter>
    </SessionContext.Provider>
  );
  return { calls };
}

describe('Pengaturan › Anggota workspace', () => {
  it('lists members with roles, invites by email and role, and shows the link once', async () => {
    const { calls } = harness('owner');
    const panel = await screen.findByRole('region', { name: 'Anggota workspace' });
    const tim = await within(panel).findByRole('listitem', { name: 'tim@nirmalab.com' });
    expect(tim).toHaveTextContent('Editor');
    const me = within(panel).getByRole('listitem', { name: 'joseph@nirmalab.com' });
    expect(me).toHaveTextContent('Pemilik');
    expect(within(me).queryByRole('button', { name: /keluarkan/i })).not.toBeInTheDocument();

    await userEvent.type(within(panel).getByRole('textbox', { name: 'Email yang diundang' }), 'B@Nirmalab.com');
    await userEvent.click(within(panel).getByRole('combobox', { name: 'Peran undangan' }));
    await userEvent.click(await screen.findByRole('option', { name: /^Editor/ }));
    await userEvent.click(within(panel).getByRole('button', { name: /kirim undangan/i }));
    await waitFor(() => expect(calls).toContainEqual(['POST', 'invite', { email: 'b@nirmalab.com', role: 'editor' }]));
    expect(await within(panel).findByText(/undangan untuk b@nirmalab\.com sebagai Editor/i)).toBeInTheDocument();
    expect(within(panel).getByText(/\/join\/tok_new/)).toBeInTheDocument();
  });

  it('changes a role, revokes a pending invite, and removes a member after saying what happens', async () => {
    const { calls } = harness('owner');
    const panel = await screen.findByRole('region', { name: 'Anggota workspace' });
    const tim = await within(panel).findByRole('listitem', { name: 'tim@nirmalab.com' });
    await userEvent.click(within(tim).getByRole('combobox', { name: /peran tim@nirmalab\.com/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^Penonton/ }));
    await waitFor(() => expect(calls).toContainEqual(['PATCH', 'member', { role: 'viewer' }]));
    expect(await within(panel).findByText(/tim@nirmalab\.com sekarang Penonton/i)).toBeInTheDocument();

    const invites = within(panel).getByRole('list', { name: 'Undangan tertunda' });
    const pending = within(invites).getByRole('listitem', { name: 'c@nirmalab.com' });
    expect(pending).toHaveTextContent(/aktif/i);
    await userEvent.click(within(pending).getByRole('button', { name: 'Cabut' }));
    await waitFor(() => expect(calls).toContainEqual(['DELETE', 'invite', null]));
    await waitFor(() => expect(within(panel).queryByRole('listitem', { name: 'c@nirmalab.com' })).not.toBeInTheDocument());

    await userEvent.click(within(panel).getByRole('button', { name: /keluarkan/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Keluarkan tim@nirmalab\.com\?/);
    expect(dialog).toHaveTextContent(/tetap di workspace/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /ya, keluarkan/i }));
    await waitFor(() => expect(calls).toContainEqual(['DELETE', 'member', null]));
    await waitFor(() => expect(within(panel).queryByRole('listitem', { name: 'tim@nirmalab.com' })).not.toBeInTheDocument());
  });

  it('shows an editor the same list read-only and says why', async () => {
    harness('editor');
    const panel = await screen.findByRole('region', { name: 'Anggota workspace' });
    expect(await within(panel).findByRole('listitem', { name: 'tim@nirmalab.com' })).toHaveTextContent('Editor');
    expect(within(panel).queryByRole('button', { name: /kirim undangan/i })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('combobox', { name: 'Peran undangan' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('status')).toHaveTextContent(/hanya Pemilik yang bisa mengundang/i);
  });

  it('says the member list failed and retries it', async () => {
    harness('owner', { failFirstRead: true });
    const panel = await screen.findByRole('region', { name: 'Anggota workspace' });
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(/Anggota workspace gagal dimuat/i);
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(panel).findByRole('listitem', { name: 'tim@nirmalab.com' })).toBeInTheDocument();
  });
});

describe('Rute /pengaturan/anggota-workspace', () => {
  it('opens the workspace members tab as a dialog over the app', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/auth/me') return ok({ user: admin });
      if (url === '/api/workspaces') return ok({ workspaces: [{ id: 'w1', name: 'Ruang kerja Joseph', role: 'owner', personal: true, projects: 1, members: 1 }] });
      if (url === '/api/workspaces/w1') return ok({ workspace: { id: 'w1', name: 'Ruang kerja Joseph', ownerId: 'u1', personal: true }, members: [{ userId: 'u1', email: 'joseph@nirmalab.com', role: 'owner', joinedAtMs: NOW }], invites: [] });
      if (url.startsWith('/api/stories')) return ok({ stories: [], catalog: { templates: [] } });
      if (url === '/api/quota') return ok({ flow: { credits: 0, usedToday: 0, capToday: 50, accounts: 0, online: false }, openrouter: { configured: false }, storage: { usedBytes: 0, diskFreeBytes: null } });
      return ok({});
    });
    render(<App fetchImpl={fetchImpl} initialPath="/pengaturan/anggota-workspace" />);
    const dialog = await screen.findByRole('dialog', { name: /pengaturan/i });
    expect(within(dialog).getByRole('tab', { name: 'Anggota workspace' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(dialog).findByRole('region', { name: 'Anggota workspace' })).toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { admin, CATALOG, fail, fakeFetch, member, ok, STORIES } from '../test/fake.js';

function app(opts: { user?: typeof admin; stories?: unknown; storiesFail?: () => boolean; path?: string } = {}) {
  const user = opts.user ?? admin;
  const fetchImpl = fakeFetch(url => {
    if (url === '/api/auth/me') return ok({ user });
    if (url === '/api/stories') return opts.storiesFail?.() ? fail(500, 'boom') : ok({ stories: opts.stories ?? STORIES });
    if (url === '/api/stories/catalog') return ok({ catalog: CATALOG, covers: {} });
    if (url === '/api/quota') return ok({ flow: { credits: 40, usedToday: 10, capToday: 50, accounts: 1, online: true }, openrouter: { configured: false, remainingUsd: null, usedUsd: null }, storage: { usedBytes: 1024 ** 3, diskFreeBytes: null } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath={opts.path ?? '/'} />);
  return fetchImpl;
}

describe('ChatGPT-style shell', () => {
  it('has a sidebar with a new-video action, the tools, and recent stories as history', async () => {
    app();
    // found while the session check may still be pending: the same sidebar must stay mounted
    const nav = await screen.findByRole('navigation', { name: /menu utama/i });
    expect(within(nav).getByRole('link', { name: /buat baru/i })).toHaveAttribute('href', '/');
    for (const label of ['Template', 'Proyek', 'Studio', 'Naskah & suara', 'Publish']) expect(within(nav).getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    const history = await screen.findByRole('list', { name: /cerita terbaru/i });
    expect(within(history).getByRole('link', { name: /jingga di pagar/i })).toHaveAttribute('href', '/cerita/story_a');
    expect(within(history).getByRole('link', { name: /kerlip dan bulan/i })).toBeInTheDocument();
  });

  it('shows an empty history with the next step', async () => {
    app({ stories: [] });
    expect(await screen.findByText(/belum ada cerita/i)).toBeInTheDocument();
  });

  it('shows a history error with a retry that reloads', async () => {
    let broken = true;
    app({ storiesFail: () => broken });
    const retry = await screen.findByRole('button', { name: /muat ulang riwayat/i });
    broken = false;
    await userEvent.click(retry);
    expect(await screen.findByRole('link', { name: /jingga di pagar/i })).toBeInTheDocument();
  });

  it('collapses and reopens the sidebar', async () => {
    app();
    await screen.findByRole('navigation', { name: /menu utama/i });
    await userEvent.click(screen.getByRole('button', { name: /tutup sidebar/i }));
    expect(screen.queryByRole('navigation', { name: /menu utama/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /buka sidebar/i }));
    expect(screen.getByRole('navigation', { name: /menu utama/i })).toBeInTheDocument();
  });

  it('searches stories from a command dialog', async () => {
    app();
    await screen.findByRole('link', { name: /jingga di pagar/i });
    await userEvent.click(screen.getByRole('button', { name: /cari cerita/i }));
    const dialog = await screen.findByRole('dialog', { name: /cari cerita/i });
    await userEvent.type(within(dialog).getByRole('textbox'), 'kerlip');
    expect(within(dialog).getByRole('link', { name: /kerlip dan bulan/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /jingga/i })).not.toBeInTheDocument();
  });

  it('puts settings, workspace and sign-out in the account menu, admin-only items for admins', async () => {
    app();
    await userEvent.click(await screen.findByRole('button', { name: /akun/i }));
    const menu = await screen.findByRole('menu');
    for (const item of [/^pengaturan$/i, /anggota/i, /penggunaan/i, /akun flow/i, /keluar/i]) expect(within(menu).getByRole('menuitem', { name: item })).toBeInTheDocument();
  });

  it('hides workspace items from members', async () => {
    app({ user: member });
    await userEvent.click(await screen.findByRole('button', { name: /akun/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^pengaturan$/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /penggunaan/i })).not.toBeInTheDocument();
  });

  it('shows the quota (bridge state + credits) above the account menu; admins open Akun Flow from it', async () => {
    app();
    const quota = await screen.findByRole('region', { name: /kuota/i });
    await waitFor(() => expect(quota).toHaveTextContent(/flow online.*40 kredit/i));
    expect(quota.compareDocumentPosition(screen.getByRole('button', { name: /^akun$/i })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('status', { name: /bridge/i })).toBeNull();
    await userEvent.click(within(quota).getByRole('button', { name: /flow online/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

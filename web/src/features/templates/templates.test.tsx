import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, CATALOG, fail, fakeFetch, ok, STORIES } from '../../test/fake.js';

function app(opts: { failFirst?: boolean } = {}) {
  let calls = 0;
  const fetchImpl = fakeFetch(url => {
    if (url === '/api/auth/me') return ok({ user: admin });
    if (url === '/api/stories') return ok({ stories: STORIES });
    if (url === '/api/stories/catalog') { calls++; return opts.failFirst && calls === 1 ? fail(500, 'boom') : ok({ catalog: CATALOG, covers: {} }); }
    if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath="/template" />);
  return fetchImpl;
}

const grid = () => screen.findByRole('list', { name: /daftar template/i });

describe('Template gallery', () => {
  it('lists every template with its category tabs', async () => {
    app();
    expect(await screen.findByRole('heading', { name: /^template$/i, level: 1 })).toBeInTheDocument();
    expect(within(await grid()).getAllByRole('listitem')).toHaveLength(4);
    const tabs = screen.getByRole('tablist', { name: /kategori/i });
    for (const t of ['Semua', 'Drama', 'Anak', 'Faceless', 'Promo']) expect(within(tabs).getByRole('tab', { name: new RegExp(`^${t}`, 'i') })).toBeInTheDocument();
  });

  it('filters by category and by search, with an empty result state', async () => {
    app();
    await grid();
    await userEvent.click(screen.getByRole('tab', { name: /^anak/i }));
    expect(within(await grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Dongeng Tidur']);
    await userEvent.click(screen.getByRole('tab', { name: /^semua/i }));
    await userEvent.type(screen.getByRole('searchbox', { name: /cari template/i }), 'kopi');
    expect(within(await grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Promo Produk']);
    await userEvent.clear(screen.getByRole('searchbox', { name: /cari template/i }));
    await userEvent.type(screen.getByRole('searchbox', { name: /cari template/i }), 'zzz');
    expect(await screen.findByText(/tidak ada template yang cocok/i)).toBeInTheDocument();
  });

  it('uses a template: opens the prompt with it selected', async () => {
    app();
    const card = within(await grid()).getByRole('listitem', { name: 'Fakta Faceless' });
    await userEvent.click(within(card).getByRole('button', { name: /pakai/i }));
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    await waitFor(() => expect(box).toHaveValue('Lima fakta tentang laut dalam.'));
  });

  it('shows an error with retry when the catalogue fails', async () => {
    app({ failFirst: true });
    await userEvent.click(await screen.findByRole('button', { name: /coba lagi/i }));
    expect(within(await grid()).getAllByRole('listitem')).toHaveLength(4);
  });
});

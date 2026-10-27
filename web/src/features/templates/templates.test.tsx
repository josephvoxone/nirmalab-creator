import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, CATALOG, fail, fakeFetch, member, ok, STORIES } from '../../test/fake.js';

function app(opts: { failFirst?: boolean; user?: typeof admin; catalog?: typeof CATALOG } = {}) {
  let calls = 0;
  const fetchImpl = fakeFetch(url => {
    if (url === '/api/auth/me') return ok({ user: opts.user ?? admin });
    if (url === '/api/stories') return ok({ stories: STORIES });
    if (url === '/api/stories/catalog') { calls++; return opts.failFirst && calls === 1 ? fail(500, 'boom') : ok({ catalog: opts.catalog ?? CATALOG, covers: {} }); }
    if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath="/template" />);
  return fetchImpl;
}

const grid = () => screen.findByRole('list', { name: /daftar template/i });

describe('Template gallery', () => {
  it('says in one muted line that a template starts a project', async () => {
    app();
    expect(await screen.findByText('Template = resep untuk memulai proyek: gaya, tempo dan jumlah shot sudah diatur.')).toHaveClass('text-muted-foreground');
  });

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

  it('cards show the app-made cover and fall back to the palette when it is missing', async () => {
    app();
    const card = within(await grid()).getByRole('listitem', { name: 'Drama Hewan' });
    const img = card.querySelector('img')!;
    // sized to the card (≈240 px wide): 320 px webp, 480 px for 2x screens
    expect(img.getAttribute('src')).toBe('/api/stories/templates/drama-hewan/cover?v=0&w=320');
    expect(img.getAttribute('srcset')).toBe('/api/stories/templates/drama-hewan/cover?v=0&w=320 1x, /api/stories/templates/drama-hewan/cover?v=0&w=480 2x');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('width');
    expect(img).toHaveAttribute('height');
    img.dispatchEvent(new Event('error'));
    await waitFor(() => expect(card.querySelector('img')).toBeNull());
  });

  it('admin regenerates a cover through the app and sees progress', async () => {
    let covers: Record<string, unknown> = {};
    const posted: string[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/me') return ok({ user: admin });
      if (url === '/api/stories') return ok({ stories: STORIES });
      if (url === '/api/stories/catalog') return ok({ catalog: CATALOG, covers });
      if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
      if (url === '/api/stories/templates/promo-produk/cover' && init?.method === 'POST') { posted.push(url); covers = { 'promo-produk': { pending: true } }; return ok({ cover: { pending: true } }); }
      return undefined;
    });
    render(<App fetchImpl={fetchImpl} initialPath="/template" />);
    const card = within(await grid()).getByRole('listitem', { name: 'Promo Produk' });
    // no regenerate icon on the card face: it lives in the admin-only three-dots menu
    expect(within(card).queryByRole('button', { name: /buat ulang cover/i })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: /menu template promo produk/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^buat ulang cover$/i }));
    expect(posted).toHaveLength(1);
    expect(await within(card).findByText(/membuat cover/i)).toBeInTheDocument();
  });

  it('members get no card menu (cover regeneration is admin-only)', async () => {
    app({ user: member });
    const card = within(await grid()).getByRole('listitem', { name: 'Promo Produk' });
    expect(within(card).queryByRole('button', { name: /menu template/i })).toBeNull();
    expect(within(card).getByRole('button', { name: /pakai promo produk/i })).toBeInTheDocument();
  });

  it('the footer ends with the aspect icon and Pakai on the right, drawn in the template proportion', async () => {
    const wide = { ...CATALOG, templates: CATALOG.templates.map(t => (t.id === 'promo-produk' ? { ...t, aspect: '16:9' } : t)) };
    app({ catalog: wide });
    const tall = within(await grid()).getByRole('listitem', { name: 'Drama Hewan' });
    const pakai = within(tall).getByRole('button', { name: /pakai drama hewan/i });
    const footer = pakai.parentElement!;
    expect(footer.lastElementChild).toBe(pakai);
    const ratio = within(footer).getByLabelText('Rasio 9:16');
    expect(ratio).toHaveTextContent('9:16');
    expect(ratio.nextElementSibling).toBe(pakai);
    const box = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-aspect-box]')!.style;
    expect(parseFloat(box(ratio).width)).toBeLessThan(parseFloat(box(ratio).height));
    const landscape = within(within(await grid()).getByRole('listitem', { name: 'Promo Produk' })).getByLabelText('Rasio 16:9');
    expect(landscape).toHaveTextContent('16:9');
    expect(parseFloat(box(landscape).width)).toBeGreaterThan(parseFloat(box(landscape).height));
  });
});

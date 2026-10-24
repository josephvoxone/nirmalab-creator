import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { TrendsPage } from './TrendsPage.js';
import { sortItems, type TrendItem, type TrendsResponse } from './trendsClient.js';

const HOUR = 3600_000;
const now = Date.now();

const ITEMS: TrendItem[] = [
  {
    id: 'trend_yt1', source: 'youtube', title: 'Kucing menunggu di pagar', channel: 'Harian Jingga',
    url: 'https://youtu.be/yt1', thumbnail: '/api/trends/trend_yt1/thumb', views: 1_240_000, likes: 52_000, comments: 900,
    publishedAtMs: now - 6 * HOUR, durationSec: 42, region: 'ID', velocity: 20_666, engagement: 0.043, hook: 'question',
    beats: [{ label: 'Pembuka', atSec: 0 }, { label: 'Masalah', atSec: 3 }, { label: 'Pembalikan', atSec: 12 }, { label: 'Penutup', atSec: 30 }],
    shotCount: 14, avgShotSec: 3, captionStyle: 'bold-top', audioType: 'vo', score: 0.91,
    look: { family: 'film-real', variant: 'cinematic-drama' }
  },
  {
    id: 'trend_yt2', source: 'youtube', title: 'Dapur kotor jadi rapi dalam 30 detik', channel: 'Rapi Kilat',
    url: 'https://youtu.be/yt2', thumbnail: '/api/trends/trend_yt2/thumb', views: 890_000,
    publishedAtMs: now - 2 * HOUR, durationSec: 28, region: 'ID', velocity: 12_000, engagement: 0.061,
    hook: 'before-after', shotCount: 9, captionStyle: 'karaoke', audioType: 'trend-sound', score: 0.82
  }
];

const OK: TrendsResponse = {
  configured: true, sources: { youtube: true, tiktok: false, instagram: false }, generatedAtMs: now - 4 * 60_000, items: ITEMS
};

type Reply = { status?: number; body: unknown };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function SearchProbe() {
  return <p data-testid="search">{useLocation().search}</p>;
}

function mount(handler: (url: string, init?: RequestInit) => Reply | undefined, path = '/tren') {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = handler(url, init);
    if (reply === undefined) throw new TypeError('Failed to fetch');
    return json(reply.body, reply.status);
  });
  const ui: ReactNode = (
    <SessionContext.Provider value={{ user: { id: 'u', email: 'a@x.io', isAdmin: true }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tren" element={<><TrendsPage /><SearchProbe /></>} />
          <Route path="/cerita/:id" element={<p>proyek baru dibuka</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
  render(ui);
  return fetchImpl;
}

const list = () => screen.findByRole('list', { name: /daftar tren/i });
const urls = (fetchImpl: ReturnType<typeof mount>) => fetchImpl.mock.calls.map(c => c[0]);

describe('Tren (what is working elsewhere, deconstructed)', () => {
  it('renders a card per item with thumbnail, hook badge, velocity, engagement and duration', async () => {
    mount(url => (url.startsWith('/api/trends?') ? { body: OK } : undefined));
    const items = within(await list()).getAllByRole('listitem');
    expect(items.map(li => li.getAttribute('aria-label'))).toEqual(['Kucing menunggu di pagar', 'Dapur kotor jadi rapi dalam 30 detik']);

    const first = items[0]!;
    const img = first.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/trends/trend_yt1/thumb?w=160');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(first).toHaveTextContent('Pertanyaan');
    expect(first).toHaveTextContent('20,7 rb/jam');
    expect(first).toHaveTextContent('4,3%');
    expect(first).toHaveTextContent('1,2 jt tayangan');
    expect(first).toHaveTextContent('0:42');
    expect(first).toHaveTextContent('YouTube');
    expect(items[1]).toHaveTextContent('Before–after');

    // The chip names the live sources only; the label carries the meaning.
    expect(screen.getByLabelText('Sumber aktif')).toHaveTextContent(/YouTube/);
    expect(screen.getByLabelText('Sumber aktif')).not.toHaveTextContent(/belum ada sumber/i);
    expect(document.querySelectorAll('select, input[type=radio], input[type=checkbox]').length).toBe(0);
  });

  it('keeps the filters in the URL and refetches with the new query', async () => {
    const fetchImpl = mount(url => (url.startsWith('/api/trends?') ? { body: OK } : undefined));
    await list();
    expect(urls(fetchImpl).at(-1)).toBe('/api/trends?region=ID&window=7d');

    await userEvent.click(screen.getByRole('combobox', { name: 'Negara' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Amerika Serikat' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/trends?region=US&window=7d'));

    await userEvent.click(screen.getByRole('radio', { name: '24 jam' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/trends?region=US&window=24h'));

    await userEvent.click(screen.getByRole('radio', { name: 'Anak' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/trends?region=US&window=24h&niche=kids'));
    expect(screen.getByTestId('search')).toHaveTextContent('?region=US&window=24h&niche=kids');

    // A fresh URL wins over the stored defaults (deep link).
    expect(screen.getByRole('combobox', { name: 'Negara' })).toHaveTextContent('Amerika Serikat');
    expect(screen.getByRole('radio', { name: 'Anak' })).toHaveAttribute('aria-checked', 'true');
  });

  it('reads the filters from the URL on first load', async () => {
    const fetchImpl = mount(url => (url.startsWith('/api/trends?') ? { body: OK } : undefined), '/tren?region=JP&window=30d&niche=cinematic');
    await list();
    expect(urls(fetchImpl)[0]).toBe('/api/trends?region=JP&window=30d&niche=cinematic');
    expect(screen.getByRole('combobox', { name: 'Negara' })).toHaveTextContent('Jepang');
  });

  it('sorts client-side without another request', async () => {
    const fetchImpl = mount(url => (url.startsWith('/api/trends?') ? { body: OK } : undefined));
    const items = within(await list()).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-label', 'Kucing menunggu di pagar');

    await userEvent.click(screen.getByRole('combobox', { name: 'Urutkan' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Interaksi tertinggi' }));
    const reordered = within(await list()).getAllByRole('listitem');
    expect(reordered[0]).toHaveAttribute('aria-label', 'Dapur kotor jadi rapi dalam 30 detik');
    expect(fetchImpl.mock.calls.filter(c => String(c[0]).startsWith('/api/trends?'))).toHaveLength(1);
    expect(sortItems(ITEMS, 'velocity')[0]!.id).toBe('trend_yt1');
  });

  it('opens the drawer with the beat map, rhythm and look suggestion', async () => {
    mount(url => (url.startsWith('/api/trends?') ? { body: OK } : undefined));
    const first = within(await list()).getAllByRole('listitem')[0]!;
    await userEvent.click(within(first).getByRole('button', { name: 'Bedah Kucing menunggu di pagar' }));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Kucing menunggu di pagar' })).toBeInTheDocument();
    expect(drawer).toHaveTextContent('Harian Jingga');
    expect(drawer).toHaveTextContent(/penonton menunggu jawabannya/i);

    const beats = within(drawer).getByRole('list', { name: /peta beat/i });
    expect(within(beats).getAllByRole('listitem').map(li => li.textContent?.replace(/\s/g, ''))).toEqual([
      '0:00Pembuka', '0:03Masalah', '0:12Pembalikan', '0:30Penutup'
    ]);
    expect(drawer).toHaveTextContent('±14 shot · potongan rata-rata 3 dtk');
    expect(drawer).toHaveTextContent('Look disarankan');
    expect(drawer).toHaveTextContent('Film realis · Drama sinematik');
    expect(drawer).toHaveTextContent('Teks tebal di atas');
    expect(drawer).toHaveTextContent('Voice-over');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Tutup bedah' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns an item into a project and opens it', async () => {
    const fetchImpl = mount((url, init) => {
      if (url === '/api/trends/trend_yt1/clone' && init?.method === 'POST') return { body: { story: { id: 'story_new', title: 'Kucing menunggu di pagar' } } };
      if (url.startsWith('/api/trends?')) return { body: OK };
      return undefined;
    });
    const first = within(await list()).getAllByRole('listitem')[0]!;
    await userEvent.click(within(first).getByRole('button', { name: /bedah/i }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Jadikan proyek' }));

    expect(await screen.findByText('proyek baru dibuka')).toBeInTheDocument();
    const post = fetchImpl.mock.calls.find(c => c[0] === '/api/trends/trend_yt1/clone');
    expect(post?.[1]?.method).toBe('POST');
  });

  it('says which env key is missing when no source is configured', async () => {
    mount(url => (url.startsWith('/api/trends?')
      ? { body: { configured: false, sources: { youtube: false, tiktok: false, instagram: false }, items: [] } }
      : undefined));
    expect(await screen.findByText(/YOUTUBE_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/nyalakan satu sumber dulu/i)).toBeInTheDocument();
    expect(screen.getByText(/butuh restart server/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /daftar tren/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jadikan proyek' })).toBeNull();
  });

  it('names the source key when only the other platforms are configured', async () => {
    mount(url => (url.startsWith('/api/trends?')
      ? { body: { configured: false, sources: { youtube: false, tiktok: false, instagram: false }, missing: ['TRENDS_DTK_URL'], items: [] } }
      : undefined));
    expect(await screen.findByText(/TRENDS_DTK_URL/)).toBeInTheDocument();
  });

  it('shows the empty copy for the current filter', async () => {
    mount(url => (url.startsWith('/api/trends?') ? { body: { ...OK, items: [] } } : undefined));
    expect(await screen.findByText('Belum ada data tren untuk filter ini')).toBeInTheDocument();
  });

  it('fails with a plain cause and recovers on retry', async () => {
    let fail = true;
    mount(url => {
      if (!url.startsWith('/api/trends?')) return undefined;
      return fail ? { status: 500, body: { error: { message: 'Trends upstream mati' } } } : { body: OK };
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/gagal memuat tren/i);
    expect(alert).toHaveTextContent(/Trends upstream mati/);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(within(await list()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('skeleton, not a bare "Memuat…", while the first request is in flight', async () => {
    mount(() => undefined);
    const status = await screen.findByRole('status', { name: 'Memuat tren' });
    expect(status.querySelectorAll('.skel, [data-slot=skeleton]').length).toBeGreaterThan(0);
    expect(status).not.toHaveTextContent('Memuat…');
  });
});

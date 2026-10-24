import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { StoriesPage } from './StoriesPage.js';

type Reply = { status?: number; body: unknown };
const ID = 'story_0123456789abcdef';
const story = (over: Record<string, unknown> = {}) => ({ id: ID, title: 'Selendang Merah', status: 'draft', createdAtMs: 1, updatedAtMs: Date.now() - 3600_000, shots: [{ id: 'a', status: 'pending', attempts: 0 }, { id: 'b', status: 'pending', attempts: 0 }], events: [], ...over });

function mount(handler: (url: string, init?: RequestInit) => Reply | undefined) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(url, init);
    if (r === undefined) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  render(
    <SessionContext.Provider value={{ user: { id: 'u', email: 'a@x.io', isAdmin: true }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={['/cerita']}>
        <Routes>
          <Route path="/cerita" element={<StoriesPage pollMs={0} />} />
          <Route path="/" element={<p>home page</p>} />
          <Route path="/template" element={<p>template page</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
  return fetchImpl;
}

const grid = () => screen.findByRole('list', { name: /daftar proyek/i });

describe('Proyek (your works, not recipes)', () => {
  it('explains how it differs from Template and lists each project with status and progress', async () => {
    mount(url => (url === '/api/stories' ? { body: { stories: [story({ status: 'rendering', shots: [{ id: 'a', status: 'done', attempts: 0 }, { id: 'b', status: 'queued', attempts: 0 }] })] } } : undefined));
    expect(screen.getByText(/template adalah resep awal/i)).toBeInTheDocument();
    const item = within(await grid()).getByRole('listitem', { name: 'Selendang Merah' });
    expect(within(item).getByRole('link', { name: /buka selendang merah/i })).toHaveAttribute('href', `/cerita/${ID}`);
    expect(item).toHaveTextContent('Dirender');
    expect(item).toHaveTextContent('1/2 shot');
    expect(document.querySelector('select')).toBeNull();
  });

  it('a finished project shows its poster and plays a preview on click (title still opens it)', async () => {
    mount(url => (url === '/api/stories' ? { body: { stories: [story({ status: 'done', video: { bytes: 1, finishedAtMs: 77 }, shots: [{ id: 'a', status: 'done', attempts: 0, frame: { status: 'done', attempts: 0, mediaId: 'm1' } }] })] } } : undefined));
    const item = within(await grid()).getByRole('listitem', { name: 'Selendang Merah' });
    expect(item.querySelector('video')).toBeNull();
    const img = item.querySelector('img')!;
    expect(img).toHaveAttribute('src', `/api/stories/${ID}/video/poster?v=77&w=320`);
    expect(img).toHaveAttribute('srcset', `/api/stories/${ID}/video/poster?v=77&w=320 1x, /api/stories/${ID}/video/poster?v=77&w=480 2x`);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    await userEvent.click(within(item).getByRole('button', { name: /putar preview selendang merah/i }));
    const video = item.querySelector('video')!;
    expect(video).toHaveAttribute('src', `/api/stories/${ID}/video?v=77`);
    expect(video).toHaveAttribute('poster', `/api/stories/${ID}/video/poster?v=77&w=480`);
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByText('home page')).toBeNull();
    expect(within(item).getByRole('link', { name: 'Selendang Merah' })).toHaveAttribute('href', `/cerita/${ID}`);
  });

  it('an unfinished project shows its first keyframe, sized for the card', async () => {
    mount(url => (url === '/api/stories' ? { body: { stories: [story({ status: 'review', shots: [{ id: 'a', status: 'pending', attempts: 0, frame: { status: 'done', attempts: 0, mediaId: 'm1' } }] })] } } : undefined));
    const item = within(await grid()).getByRole('listitem', { name: 'Selendang Merah' });
    expect(item.querySelector('img')).toHaveAttribute('src', `/api/stories/${ID}/shots/a/frame?v=m1&w=320`);
    expect(within(item).queryByRole('button', { name: /putar preview/i })).toBeNull();
  });

  it('filters by status with counts, and searches by title', async () => {
    mount(url => (url === '/api/stories' ? { body: { stories: [
      story({ id: 'story_a', title: 'Jingga', status: 'review' }),
      story({ id: 'story_b', title: 'Kerlip', status: 'done' }),
      story({ id: 'story_c', title: 'Kancil', status: 'rendering' })
    ] } } : undefined));
    await grid();
    const tabs = screen.getByRole('tablist', { name: /status/i });
    expect(within(tabs).getByRole('tab', { name: /siap direview 1/i })).toBeInTheDocument();
    await userEvent.click(within(tabs).getByRole('tab', { name: /^selesai/i }));
    expect(within(await grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Kerlip']);
    await userEvent.click(within(tabs).getByRole('tab', { name: /^semua/i }));
    await userEvent.type(screen.getByRole('searchbox', { name: /cari proyek/i }), 'kan');
    expect(within(await grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Kancil']);
  });

  it('deletes a project only after confirming', async () => {
    let stories = [story()];
    const fetchImpl = mount((url, init) => {
      if (url === '/api/stories' && !init?.method) return { body: { stories } };
      if (url === `/api/stories/${ID}` && init?.method === 'DELETE') { stories = []; return { body: { ok: true } }; }
      return undefined;
    });
    const item = within(await grid()).getByRole('listitem', { name: 'Selendang Merah' });
    await userEvent.click(within(item).getByRole('button', { name: /hapus selendang merah/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(fetchImpl.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false);
    await userEvent.click(within(confirm).getByRole('button', { name: /^hapus$/i }));
    await waitFor(() => expect(fetchImpl.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(true));
    expect(await screen.findByRole('heading', { name: /belum ada proyek/i })).toBeInTheDocument();
  });

  it('empty state offers the two ways to start', async () => {
    mount(url => (url === '/api/stories' ? { body: { stories: [] } } : undefined));
    expect(await screen.findByRole('heading', { name: /belum ada proyek/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /lihat template/i }));
    expect(await screen.findByText('template page')).toBeInTheDocument();
  });

  it('error with retry, then recovers', async () => {
    let fail = true;
    mount(url => (url === '/api/stories' ? (fail ? undefined : { body: { stories: [story()] } }) : undefined));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/gagal memuat proyek/i);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(within(await grid()).getByRole('listitem', { name: 'Selendang Merah' })).toBeInTheDocument();
  });
});

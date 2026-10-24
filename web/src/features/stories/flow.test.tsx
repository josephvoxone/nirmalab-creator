import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { buildGraph } from './flowGraph.js';
import { StoriesPage } from './StoriesPage.js';
import { StoryDetailPage } from './StoryDetailPage.js';
import { CATALOG, look } from './testCatalog.js';
import type { Story, Storyboard } from './storiesClient.js';

const ID = 'story_0123456789abcdef';
const board: Storyboard = {
  title: 'Selendang Merah', mode: 'konsisten', look: look({}),
  characters: { LARAS: 'a girl', KAPAS: { name: 'Kapas', look: 'a rabbit' } },
  shots: [
    { id: '00-intro', silent: true, prompt: 'Wide shot, the camera pushes in slowly. A valley.' },
    { id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS hugs KAPAS.', narration: 'Namanya Kapas.' },
    { id: '02-hujan', prompt: 'Wide shot, the camera stays still. KAPAS waits in the rain.', narration: 'Ia menunggu.' }
  ]
};
const take = (status: string) => ({ status: status as 'done', attempts: 0, ...(status === 'done' ? { mediaId: 'm' } : {}) });
const story = (over: Partial<Story> = {}): Story => ({
  id: ID, title: 'Selendang Merah', status: 'framing', mode: 'konsisten', createdAtMs: 0, updatedAtMs: 0, events: [],
  cast: [{ token: 'LARAS', name: 'Laras', ...take('done') }, { token: 'KAPAS', name: 'Kapas', ...take('done') }],
  shots: [
    { id: '00-intro', status: 'pending', attempts: 0, frame: take('done') },
    { id: '01-hadiah', status: 'pending', attempts: 0, frame: { status: 'queued', attempts: 1, lastError: 'Keyframe bukan 9:16' } },
    { id: '02-hujan', status: 'pending', attempts: 0, frame: { status: 'failed', attempts: 3, error: 'Flow: policy violation' } }
  ],
  ...over
});

describe('buildGraph (ComfyUI-style DAG of the pipeline)', () => {
  it('konsisten: storyboard → characters → keyframes → clips → final, wired by who appears where', () => {
    const g = buildGraph(story(), board);
    const kinds = g.nodes.map(n => n.kind);
    expect(kinds.filter(k => k === 'cast')).toHaveLength(2);
    expect(kinds.filter(k => k === 'frame')).toHaveLength(3);
    expect(kinds.filter(k => k === 'clip')).toHaveLength(3);
    expect(kinds.filter(k => k === 'final')).toHaveLength(1);
    const has = (a: string, b: string) => g.edges.some(e => e.from === a && e.to === b);
    expect(has('storyboard', 'cast:LARAS')).toBe(true);
    expect(has('cast:LARAS', 'frame:01-hadiah')).toBe(true);
    expect(has('cast:LARAS', 'frame:02-hujan')).toBe(false);
    expect(has('cast:KAPAS', 'frame:02-hujan')).toBe(true);
    expect(has('storyboard', 'look')).toBe(true);
    expect(has('look', 'frame:00-intro')).toBe(true);
    expect(has('look', 'frame:02-hujan')).toBe(true);
    expect(has('storyboard', 'frame:00-intro')).toBe(false);
    expect(has('frame:01-hadiah', 'clip:01-hadiah')).toBe(true);
    expect(has('clip:02-hujan', 'final')).toBe(true);
    const node = (id: string) => g.nodes.find(n => n.id === id)!;
    expect(node('frame:00-intro').status).toBe('done');
    expect(node('frame:01-hadiah').status).toBe('running');
    expect(node('frame:01-hadiah').note).toMatch(/take 2.*9:16/);
    expect(node('frame:02-hujan').status).toBe('failed');
    expect(node('frame:02-hujan').note).toMatch(/policy violation/);
    expect(node('final').status).toBe('idle');
  });

  it('cepat: storyboard → clips → final, no character or keyframe nodes', () => {
    const g = buildGraph(story({ mode: 'cepat', cast: undefined, shots: story().shots.map(s => ({ ...s, frame: undefined })) }), { ...board, mode: 'cepat' });
    expect(g.nodes.some(n => n.kind === 'cast' || n.kind === 'frame')).toBe(false);
    expect(g.edges.some(e => e.from === 'look' && e.to === 'clip:01-hadiah')).toBe(true);
  });
});

function harness(routes: (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/stories/catalog') return new Response(JSON.stringify({ catalog: CATALOG, covers: {} }), { status: 200 });
    const r = routes(url, init);
    if (r === undefined) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
}

function mount(path: string, fetchImpl: ReturnType<typeof harness>, isAdmin = true) {
  return render(
    <SessionContext.Provider value={{ user: { id: 'u', email: 'a@x.io', isAdmin }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cerita" element={<StoriesPage pollMs={50} />} />
          <Route path="/cerita/:id" element={<StoryDetailPage pollMs={30} />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

describe('flow canvas on the story page', () => {
  it('renders every node with its status and opens an inspector for the clicked node', async () => {
    mount(`/cerita/${ID}`, harness(url => (url === `/api/stories/${ID}` ? { body: { story: story(), storyboard: board } } : { body: {} })));
    const canvas = await screen.findByRole('region', { name: 'Alur produksi' });
    expect(within(canvas).getAllByRole('button', { name: /^Keyframe/ })).toHaveLength(3);
    expect(within(canvas).getByRole('button', { name: /Keyframe 02-hujan · Gagal/ })).toBeTruthy();
    expect(within(canvas).getByRole('button', { name: /Karakter Laras · Selesai/ })).toBeTruthy();
    expect(canvas.querySelectorAll('path.flow-edge').length).toBeGreaterThanOrEqual(10);
    await userEvent.click(within(canvas).getByRole('button', { name: /Keyframe 01-hadiah/ }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('Namanya Kapas.')).toBeTruthy();
    expect(within(inspector).getByText(/take ulang/i)).toBeTruthy();
    await userEvent.click(within(inspector).getByRole('button', { name: 'Tutup inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('zoom controls scale the canvas', async () => {
    mount(`/cerita/${ID}`, harness(url => (url === `/api/stories/${ID}` ? { body: { story: story(), storyboard: board } } : { body: {} })));
    await screen.findByRole('region', { name: 'Alur produksi' });
    const before = Number(screen.getByTestId('flow-zoom').textContent!.replace('%', ''));
    await userEvent.click(screen.getByRole('button', { name: 'Perkecil' }));
    expect(screen.getByTestId('flow-zoom').textContent).toBe(`${before - 10}%`);
    await userEvent.click(screen.getByRole('button', { name: 'Pas layar' }));
    expect(screen.getByTestId('flow-zoom').textContent).toBe('100%');
  });
});

describe('loading, empty and error states', () => {
  it('story page: skeleton while loading, then content', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/stories/catalog') return new Response(JSON.stringify({ catalog: CATALOG }), { status: 200 });
      await gate;
      return new Response(JSON.stringify({ story: story(), storyboard: board }), { status: 200 });
    });
    mount(`/cerita/${ID}`, fetchImpl as unknown as ReturnType<typeof harness>);
    expect(screen.getByRole('status', { name: 'Memuat cerita' })).toBeTruthy();
    release();
    expect(await screen.findByRole('region', { name: 'Alur produksi' })).toBeTruthy();
  });

  it('story page: not found explains and links back to the list', async () => {
    mount(`/cerita/${ID}`, harness(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Story not found' } } })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Cerita tidak ditemukan/);
    expect(within(alert).getByRole('link', { name: /daftar cerita/i }).getAttribute('href')).toBe('/cerita');
  });

  it('story page: network failure offers retry and recovers', async () => {
    let fail = true;
    mount(`/cerita/${ID}`, harness(url => (fail ? undefined : url === `/api/stories/${ID}` ? { body: { story: story(), storyboard: board } } : { body: {} })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/koneksi/i);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('region', { name: 'Alur produksi' })).toBeTruthy();
  });

  it('story page: a failed background refresh keeps the content and says so', async () => {
    let calls = 0;
    mount(`/cerita/${ID}`, harness(url => {
      if (url !== `/api/stories/${ID}`) return { body: {} };
      calls += 1;
      return calls === 1 ? { body: { story: story(), storyboard: board } } : undefined;
    }));
    await screen.findByRole('region', { name: 'Alur produksi' });
    expect(await screen.findByText(/Gagal memperbarui status/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Alur produksi' })).toBeTruthy();
  });

  it('list page: projects skeleton, then empty state with the action that fills it', async () => {
    mount('/cerita', harness(url => (url === '/api/stories' ? { body: { stories: [] } } : { body: {} })));
    const empty = await screen.findByRole('heading', { name: 'Belum ada cerita' });
    const box = empty.closest('.state-empty') as HTMLElement;
    await userEvent.click(within(box).getByRole('button', { name: /Pilih template/ }));
    await waitFor(() => expect(document.activeElement?.closest('.template-grid')).toBeTruthy());
  });

  it('list page: failed project list is an error with retry, the composer still works', async () => {
    let fail = true;
    mount('/cerita', harness(url => (url === '/api/stories' ? (fail ? undefined : { body: { stories: [] } }) : { body: {} })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Gagal memuat proyek/);
    expect(screen.getByLabelText('Premis cerita')).toBeTruthy();
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('heading', { name: 'Belum ada cerita' })).toBeTruthy();
  });

  it('list page: catalog failure is an error with retry instead of a blank page', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/stories/catalog') {
        if (fail) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 503 });
        return new Response(JSON.stringify({ catalog: CATALOG, covers: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ stories: [] }), { status: 200 });
    });
    mount('/cerita', fetchImpl as unknown as ReturnType<typeof harness>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Gagal memuat template/);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByLabelText('Premis cerita')).toBeTruthy();
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { StoriesPage } from './StoriesPage.js';
import { StoryDetailPage } from './StoryDetailPage.js';
import { readSetup, setShotSetup } from './catalog.js';
import { CATALOG, look } from './testCatalog.js';

type Reply = { status?: number; body: unknown };
type Call = { url: string; method: string; body?: unknown };

function harness(routes: (call: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = (url === '/api/stories/catalog' ? { body: { catalog: CATALOG } } : routes(call)) ?? { status: 404, body: { error: { message: 'not found' } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetchImpl };
}

function mount(path: string, fetchImpl: ReturnType<typeof harness>['fetchImpl']) {
  const session = { user: { id: 'u', email: 'a@x.io', isAdmin: true }, fetchImpl, signOut: async () => undefined };
  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cerita" element={<StoriesPage />} />
          <Route path="/cerita/:id" element={<StoryDetailPage pollMs={20} />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

describe('shot setup helpers', () => {
  it('reads and rewrites the framing + move sentence', () => {
    const p = 'Medium shot, the camera stays still. LARAS hugs KAPAS.';
    expect(readSetup(p, CATALOG)).toEqual({ framing: 'medium', move: 'static' });
    expect(setShotSetup(p, CATALOG, 'close-up', 'push-in')).toBe('Close-up, the camera pushes in slowly. LARAS hugs KAPAS.');
    expect(setShotSetup('KAPAS waits.', CATALOG, 'wide', 'static')).toBe('Wide shot, the camera stays still. KAPAS waits.');
  });
});

describe('Studio cerita (composer)', () => {
  it('template card fills the look chips, mode and example premise', async () => {
    const { fetchImpl } = harness(c => (c.url === '/api/stories' ? { body: { stories: [] } } : undefined));
    mount('/cerita', fetchImpl);
    const card = await screen.findByRole('button', { name: /Dongeng Tidur/ });
    await userEvent.click(card);
    expect(screen.getByRole('button', { name: /Palet warna.*Pastel Kapas/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Film setup.*Dongeng/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Konsisten/ })).toHaveProperty('checked', true);
    expect((screen.getByLabelText('Premis cerita') as HTMLTextAreaElement).value).toMatch(/Bintang kecil/);
    expect(screen.getByLabelText('Jumlah shot')).toHaveProperty('value', '6');
  });

  it('template cards show their cover still, and fall back to the palette when it is missing', async () => {
    const { fetchImpl } = harness(c => (c.url === '/api/stories' ? { body: { stories: [] } } : undefined));
    mount('/cerita', fetchImpl);
    const card = await screen.findByRole('button', { name: /Drama Hewan/ });
    const img = card.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/templates/drama-hewan.jpg');
    expect(img.getAttribute('alt')).toBe('');
    img.dispatchEvent(new Event('error'));
    await waitFor(() => expect(card.querySelector('img')).toBeNull());
  });

  it('palette dialog: pick, chip updates, Esc closes', async () => {
    const { fetchImpl } = harness(c => (c.url === '/api/stories' ? { body: { stories: [] } } : undefined));
    mount('/cerita', fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /Palet warna/ }));
    const dialog = screen.getByRole('dialog', { name: 'Palet warna' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Noir Monokrom/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /Palet warna.*Noir Monokrom/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Kamera/ }));
    expect(screen.getByRole('dialog', { name: 'Kamera' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('film setup tabs: tempo sets the shot count', async () => {
    const { fetchImpl } = harness(c => (c.url === '/api/stories' ? { body: { stories: [] } } : undefined));
    mount('/cerita', fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /Film setup/ }));
    const dialog = screen.getByRole('dialog', { name: 'Film setup' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tempo' }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Dinamis/ }));
    expect(screen.getByLabelText('Jumlah shot')).toHaveProperty('value', '10');
  });

  it('submits premise + template + look + mode and opens the story', async () => {
    const { fetchImpl, calls } = harness(c => {
      if (c.url === '/api/stories' && c.method === 'GET') return { body: { stories: [] } };
      if (c.url === '/api/stories/draft') return { status: 201, body: { story: { id: 'story_0123456789abcdef' } } };
      if (c.url.startsWith('/api/stories/story_')) return { body: { story: { id: 'story_0123456789abcdef', title: 'T', status: 'draft', mode: 'konsisten', shots: [], events: [], createdAtMs: 0, updatedAtMs: 0 }, storyboard: { title: 'T', shots: [] } } };
      return undefined;
    });
    mount('/cerita', fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /Drama Hewan/ }));
    await userEvent.click(screen.getByRole('button', { name: /Coba contoh/ }));
    await userEvent.click(screen.getByRole('button', { name: /Tulis storyboard/ }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/stories/draft')).toBe(true));
    const body = calls.find(c => c.url === '/api/stories/draft')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ template: 'drama-hewan', mode: 'konsisten', aspect: '9:16', shots: 8 });
    expect(body.premise).toMatch(/kucing oranye/);
    expect(body.look).toMatchObject({ genre: 'drama', palette: 'senja', style: 'storybook' });
    expect(await screen.findByRole('heading', { name: 'T' })).toBeTruthy();
  });
});

const ID = 'story_0123456789abcdef';
const konsistenBoard = {
  title: 'Selendang Merah', mode: 'konsisten', template: 'drama-hewan', look: look({ genre: 'drama', palette: 'senja' }),
  characters: { LARAS: 'a girl with two braids', KAPAS: { name: 'Kapas', look: 'a cream rabbit' } },
  shots: [
    { id: '00-intro', silent: true, prompt: 'Wide shot, the camera pushes in slowly. A valley.' },
    { id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS hugs KAPAS.', narration: 'Namanya Kapas.' }
  ]
};
const take = (status: string) => ({ status, attempts: 0, mediaId: status === 'done' ? 'm' : undefined });
const storyIn = (status: string, frames: string) => ({
  id: ID, title: 'Selendang Merah', status, mode: 'konsisten', createdAtMs: 0, updatedAtMs: 0, events: [],
  cast: [{ token: 'LARAS', name: 'Laras', ...take(frames) }, { token: 'KAPAS', name: 'Kapas', ...take(frames) }],
  shots: [{ id: '00-intro', status: 'pending', attempts: 0, frame: take(frames) }, { id: '01-hadiah', status: 'pending', attempts: 0, frame: take(frames) }]
});

describe('Story detail (konsisten pipeline)', () => {
  it('draft: one free action creates characters and keyframes', async () => {
    const { fetchImpl, calls } = harness(c => {
      if (c.url === `/api/stories/${ID}`) return { body: { story: storyIn('draft', 'pending'), storyboard: konsistenBoard } };
      if (c.url === `/api/stories/${ID}/prepare`) return { body: { story: storyIn('casting', 'pending') } };
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    const go = await screen.findByRole('button', { name: /Buat karakter & keyframe/ });
    expect(go.textContent).toMatch(/gratis/i);
    expect(screen.queryByRole('button', { name: /Render video/ })).toBeNull();
    await userEvent.click(go);
    await waitFor(() => expect(calls.some(c => c.url === `/api/stories/${ID}/prepare` && c.method === 'POST')).toBe(true));
  });

  it('review: shows character sheets and keyframes, render costs only the video shots', async () => {
    const { fetchImpl, calls } = harness(c => {
      if (c.url === `/api/stories/${ID}`) return { body: { story: storyIn('review', 'done'), storyboard: konsistenBoard } };
      if (c.url === `/api/stories/${ID}/render`) return { body: { story: storyIn('rendering', 'done') } };
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    const cast = await screen.findByRole('region', { name: 'Karakter' });
    expect(within(cast).getByRole('img', { name: /Laras/ }).getAttribute('src')).toBe(`/api/stories/${ID}/cast/LARAS/image`);
    const sb = screen.getByRole('region', { name: 'Storyboard' });
    expect(within(sb).getByRole('img', { name: /01-hadiah/ }).getAttribute('src')).toMatch(`/api/stories/${ID}/shots/01-hadiah/frame`);
    const render = screen.getByRole('button', { name: /Render video/ });
    expect(render.textContent).toMatch(/20 kredit/);
    await userEvent.click(render);
    await waitFor(() => expect(calls.some(c => c.url === `/api/stories/${ID}/render` && c.method === 'POST')).toBe(true));
  });

  it('review: changing a shot\'s camera move redraws only that keyframe with the rewritten prompt', async () => {
    const { fetchImpl, calls } = harness(c => {
      if (c.url === `/api/stories/${ID}`) return { body: { story: storyIn('review', 'done'), storyboard: konsistenBoard } };
      if (c.url === `/api/stories/${ID}/shots/01-hadiah/frame`) return { body: { story: storyIn('framing', 'done') } };
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    const card = await screen.findByRole('article', { name: /01-hadiah/ });
    await userEvent.selectOptions(within(card).getByLabelText('Gerakan kamera'), 'push-in');
    await userEvent.click(within(card).getByRole('button', { name: /Gambar ulang/ }));
    await waitFor(() => expect(calls.some(c => c.url === `/api/stories/${ID}/shots/01-hadiah/frame`)).toBe(true));
    expect(calls.find(c => c.url.endsWith('/frame'))!.body).toEqual({ prompt: 'Medium shot, the camera pushes in slowly. LARAS hugs KAPAS.' });
  });

  it('look chips on a story post the new look', async () => {
    const { fetchImpl, calls } = harness(c => {
      if (c.url === `/api/stories/${ID}`) return { body: { story: storyIn('review', 'done'), storyboard: konsistenBoard } };
      if (c.url === `/api/stories/${ID}/look`) return { body: { story: storyIn('draft', 'pending') } };
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /Palet warna.*Senja Dongeng/ }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Noir Monokrom/ }));
    await waitFor(() => expect(calls.some(c => c.url === `/api/stories/${ID}/look`)).toBe(true));
    expect(calls.find(c => c.url.endsWith('/look'))!.body).toEqual({ look: { palette: 'noir' } });
  });
});

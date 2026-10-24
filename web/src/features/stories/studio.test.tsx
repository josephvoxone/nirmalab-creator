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
          <Route path="/cerita" element={<StoriesPage pollMs={50} />} />
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
    expect(card.querySelector('select')).toBeNull();
    await userEvent.click(within(card).getByRole('combobox', { name: 'Gerakan kamera' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Push in' }));
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

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { StoriesPage } from './StoriesPage.js';
import { StoryDetailPage } from './StoryDetailPage.js';
import { CATALOG } from './testCatalog.js';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init?: RequestInit) => Reply | undefined;

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = (url === '/api/stories/catalog' ? { body: { catalog: CATALOG } } : handler(url, init)) ?? { status: 404, body: { error: { message: 'not found' } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

function mount(path: string, fetchImpl: ReturnType<typeof fakeFetch>) {
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

const ID = 'story_0123456789abcdef';
const shots = (status: string) => [
  { id: '00-intro', status, attempts: 0 },
  { id: '01-hadiah', status, attempts: 0 }
];
const board = {
  title: 'Selendang Merah',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-hadiah', prompt: 'Medium shot of a girl and a rabbit.', narration: 'Namanya Kapas.' }
  ]
};
const story = (over: Record<string, unknown> = {}) => ({ id: ID, title: 'Selendang Merah', status: 'draft', createdAtMs: 1, updatedAtMs: 1, shots: shots('pending'), events: [], ...over });

describe('StoriesPage', () => {
  it('lists stories with status and progress', async () => {
    const fetchImpl = fakeFetch(url => (url === '/api/stories' ? { body: { stories: [story({ status: 'rendering', shots: [{ id: 'a', status: 'done', attempts: 0 }, { id: 'b', status: 'queued', attempts: 0 }] })] } } : undefined));
    mount('/cerita', fetchImpl);
    const link = await screen.findByRole('link', { name: 'Selendang Merah' });
    expect(link).toHaveAttribute('href', `/cerita/${ID}`);
    const row = link.closest('.row') as HTMLElement;
    expect(within(row).getByText('Dirender')).toBeInTheDocument();
    expect(within(row).getByText('1/2 shot')).toBeInTheDocument();
  });

  it('drafts a storyboard from a premise and opens it', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/stories' && !init?.method) return { body: { stories: [] } };
      if (url === '/api/stories/draft') { body = JSON.parse(String(init?.body)); return { status: 201, body: { story: story() } }; }
      if (url === `/api/stories/${ID}`) return { body: { story: story(), storyboard: board } };
      return undefined;
    });
    mount('/cerita', fetchImpl);
    await userEvent.type(await screen.findByLabelText(/premis/i), 'Kelinci dibuang lalu ditemukan kembali');
    await userEvent.selectOptions(screen.getByLabelText(/jumlah shot/i), '8');
    await userEvent.click(screen.getByRole('button', { name: /tulis storyboard/i }));
    await waitFor(() => expect(body).toMatchObject({ premise: 'Kelinci dibuang lalu ditemukan kembali', shots: 8, mode: 'konsisten' }));
    expect(body?.look).toMatchObject({ style: 'storybook' });
    expect(await screen.findByRole('heading', { name: 'Selendang Merah' })).toBeInTheDocument();
  });

  it('shows the server error when drafting fails', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/stories' && !init?.method) return { body: { stories: [] } };
      if (url === '/api/stories/draft') return { status: 503, body: { error: { message: 'Pollinations needs an API key' } } };
      return undefined;
    });
    mount('/cerita', fetchImpl);
    await userEvent.type(await screen.findByLabelText(/premis/i), 'Cerita tentang kucing');
    await userEvent.click(screen.getByRole('button', { name: /tulis storyboard/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pollinations needs an API key');
  });
});

describe('StoryDetailPage', () => {
  it('shows the shots with narration and renders on click', async () => {
    let rendered = false;
    const fetchImpl = fakeFetch((url, init) => {
      if (url === `/api/stories/${ID}`) return { body: { story: story(rendered ? { status: 'rendering', shots: shots('queued') } : {}), storyboard: board } };
      if (url === `/api/stories/${ID}/render` && init?.method === 'POST') { rendered = true; return { body: { story: story({ status: 'rendering', shots: shots('queued') }) } }; }
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    expect(await screen.findByText('Namanya Kapas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /render video/i })).toHaveTextContent('20 kredit');
    await userEvent.click(screen.getByRole('button', { name: /render video/i }));
    expect(await screen.findByText('Dirender', { selector: '.pill' })).toBeInTheDocument();
  });

  it('on a budget refusal explains it and offers to render anyway', async () => {
    const calls: unknown[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (url === `/api/stories/${ID}`) return { body: { story: story(), storyboard: board } };
      if (url === `/api/stories/${ID}/render`) {
        const b = JSON.parse(String(init?.body));
        calls.push(b);
        return b.force ? { body: { story: story({ status: 'rendering', shots: shots('queued') }) } } : { status: 409, body: { error: { code: 'BUDGET', message: 'Butuh ±20 credits untuk 2 shot, tersisa 3 credits di akun Flow' } } };
      }
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /render video/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tersisa 3 credits');
    await userEvent.click(screen.getByRole('button', { name: /tetap render/i }));
    await waitFor(() => expect(calls).toEqual([{ force: false }, { force: true }]));
  });

  it('polls while rendering and shows the player and download when done', async () => {
    let n = 0;
    const fetchImpl = fakeFetch(url => {
      if (url === `/api/stories/${ID}`) {
        n += 1;
        const done = n >= 3;
        return { body: { story: story(done ? { status: 'done', shots: shots('done'), video: { bytes: 23958989, finishedAtMs: 2 } } : { status: 'rendering', shots: shots('queued') }), storyboard: board } };
      }
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    const player = await screen.findByTestId('story-player', {}, { timeout: 2000 });
    expect(player).toHaveAttribute('src', `/api/stories/${ID}/video`);
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', `/api/stories/${ID}/video`);
    expect(screen.getByText(/22,8 MB|22.8 MB/)).toBeInTheDocument();
  });

  it('shows why it failed and retries', async () => {
    let retried = false;
    const failed = story({ status: 'failed', error: '01-hadiah: Klip tanpa suara narasi (no audio) (setelah 3 take)', shots: [{ id: '00-intro', status: 'done', attempts: 0 }, { id: '01-hadiah', status: 'failed', attempts: 3, error: 'Klip tanpa suara narasi (no audio) (setelah 3 take)' }] });
    const fetchImpl = fakeFetch((url, init) => {
      if (url === `/api/stories/${ID}`) return { body: { story: retried ? story({ status: 'rendering', shots: shots('queued') }) : failed, storyboard: board } };
      if (url === `/api/stories/${ID}/retry` && init?.method === 'POST') { retried = true; return { body: { story: story({ status: 'rendering' }) } }; }
      return undefined;
    });
    mount(`/cerita/${ID}`, fetchImpl);
    expect(await screen.findByRole('alert')).toHaveTextContent('no audio');
    expect(screen.getByText(/3 take/, { selector: '.shot-card *' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /ulangi/i }));
    await waitFor(() => expect(retried).toBe(true));
  });

  it('shot thumbnails show a real frame without cramped native controls; finished story KPI says all shots ready', async () => {
    const fetchImpl = fakeFetch(url => (url === `/api/stories/${ID}` ? { body: { story: story({ status: 'done', shots: shots('done'), video: { bytes: 1000, finishedAtMs: 2 } }), storyboard: board } } : undefined));
    const { container } = mount(`/cerita/${ID}`, fetchImpl);
    await screen.findByTestId('story-player');
    const thumbs = [...container.querySelectorAll('.shot-card video')] as HTMLVideoElement[];
    expect(thumbs).toHaveLength(2);
    for (const v of thumbs) {
      expect(v.getAttribute('src')).toMatch(/\/video#t=1\.5$/);
      expect(v.hasAttribute('controls')).toBe(false);
    }
    expect(screen.getByText(/2\/2 video/)).toBeInTheDocument();
  });
});

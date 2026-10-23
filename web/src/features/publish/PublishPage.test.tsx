import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import PublishPage from './PublishPage.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin: User = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));

function renderPage(fetchImpl: ReturnType<typeof fakeFetch>, opts: { user?: User; openUrl?: (url: string) => void } = {}) {
  return render(
    <SessionContext.Provider value={{ user: opts.user ?? admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><PublishPage openUrl={opts.openUrl} /></MemoryRouter>
    </SessionContext.Provider>
  );
}

const statuses = (connected: Partial<Record<'youtube' | 'tiktok' | 'meta', boolean>>, configured = true) => ({
  publishers: (['youtube', 'tiktok', 'meta'] as const).map(platform => ({
    platform,
    configured: platform === 'meta' ? false : configured,
    connected: connected[platform] ?? false,
    ...(connected[platform] ? { accountLabel: `${platform}-channel` } : {})
  }))
});

const stories = {
  stories: [
    { id: 'story_aaaaaaaaaaaaaaaa', title: 'Kucing Hilang', status: 'done', video: { bytes: 5_000_000 } },
    { id: 'story_bbbbbbbbbbbbbbbb', title: 'Masih Render', status: 'rendering' },
    { id: 'story_cccccccccccccccc', title: 'Hujan Pertama', status: 'done', video: { bytes: 3_000_000 } }
  ]
};

describe('PublishPage', () => {
  it('lists each platform with its connection status', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: true }) };
      if (url === '/api/stories') return { status: 200, body: { stories: [] } };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: /platform/i });
    const yt = await within(card).findByRole('listitem', { name: 'YouTube' });
    expect(yt).toHaveTextContent('Terhubung');
    expect(yt).toHaveTextContent('youtube-channel');
    expect(within(yt).getByRole('button', { name: /putuskan/i })).toBeInTheDocument();
    const tt = within(card).getByRole('listitem', { name: 'TikTok' });
    expect(tt).toHaveTextContent('Belum terhubung');
    expect(within(tt).getByRole('button', { name: /hubungkan/i })).toBeEnabled();
    const meta = within(card).getByRole('listitem', { name: 'Meta' });
    expect(meta).toHaveTextContent(/belum dikonfigurasi/i);
    expect(within(meta).getByRole('button', { name: /hubungkan/i })).toBeDisabled();
  });

  it('connect opens the OAuth URL from the server; disconnect refreshes the status', async () => {
    let ytConnected = true;
    const openUrl = vi.fn();
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: ytConnected }) };
      if (url === '/api/stories') return { status: 200, body: { stories: [] } };
      if (url === '/api/publish/tiktok/connect' && init?.method === 'POST') return { status: 200, body: { url: 'https://www.tiktok.com/v2/auth/authorize?x=1', state: 's' } };
      if (url === '/api/publish/youtube/disconnect' && init?.method === 'POST') { ytConnected = false; return { status: 200, body: { ok: true } }; }
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, { openUrl });
    const card = screen.getByRole('region', { name: /platform/i });
    const tt = await within(card).findByRole('listitem', { name: 'TikTok' });
    await userEvent.click(within(tt).getByRole('button', { name: /hubungkan/i }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://www.tiktok.com/v2/auth/authorize?x=1'));
    const yt = within(card).getByRole('listitem', { name: 'YouTube' });
    await userEvent.click(within(yt).getByRole('button', { name: /putuskan/i }));
    await waitFor(() => expect(within(card).getByRole('listitem', { name: 'YouTube' })).toHaveTextContent('Belum terhubung'));
  });

  it('shows the server message when connecting fails', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({}) };
      if (url === '/api/stories') return { status: 200, body: { stories: [] } };
      if (url === '/api/publish/youtube/connect') return { status: 503, body: { error: { code: 'NOT_CONFIGURED', message: 'YouTube client belum diatur' } } };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, { openUrl: vi.fn() });
    const card = screen.getByRole('region', { name: /platform/i });
    const yt = await within(card).findByRole('listitem', { name: 'YouTube' });
    await userEvent.click(within(yt).getByRole('button', { name: /hubungkan/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('YouTube client belum diatur');
  });

  it('publishes a finished story by storyId to a connected platform', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: true }) };
      if (url === '/api/stories') return { status: 200, body: stories };
      if (url === '/api/publish/youtube/publish' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ storyId: 'story_cccccccccccccccc', title: 'Hujan Pertama #shorts', description: 'Cerita pendek', visibility: 'public' });
        return { status: 200, body: { ok: true, platform: 'youtube', externalId: 'abc', url: 'https://youtu.be/abc' } };
      }
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: /publish video cerita/i });
    const story = within(card).getByLabelText(/cerita/i);
    await waitFor(() => expect(within(story).getByRole('option', { name: /hujan pertama/i })).toBeInTheDocument());
    expect(within(story).queryByRole('option', { name: /masih render/i })).not.toBeInTheDocument();
    await userEvent.selectOptions(story, 'story_cccccccccccccccc');
    const title = within(card).getByLabelText(/judul/i);
    expect(title).toHaveValue('Hujan Pertama');
    await userEvent.type(title, ' #shorts');
    await userEvent.type(within(card).getByLabelText(/deskripsi/i), 'Cerita pendek');
    await userEvent.selectOptions(within(card).getByLabelText(/visibilitas/i), 'public');
    const platform = within(card).getByLabelText(/platform/i);
    expect(within(platform).getAllByRole('option').map(o => o.textContent)).toEqual(['YouTube']);
    await userEvent.click(within(card).getByRole('button', { name: /^publish$/i }));
    const link = await within(card).findByRole('link', { name: /lihat/i });
    expect(link).toHaveAttribute('href', 'https://youtu.be/abc');
  });

  it('shows the server error message when publishing fails', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: true }) };
      if (url === '/api/stories') return { status: 200, body: stories };
      if (url === '/api/publish/youtube/publish') return { status: 409, body: { error: { code: 'NEEDS_RECONNECT', message: 'Sambungkan ulang YouTube' } } };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: /publish video cerita/i });
    await waitFor(() => expect(within(card).getByLabelText(/judul/i)).toHaveValue('Kucing Hilang'));
    await userEvent.click(within(card).getByRole('button', { name: /^publish$/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Sambungkan ulang YouTube');
  });

  it('explains what is missing when nothing can be published', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({}) };
      if (url === '/api/stories') return { status: 200, body: { stories: [stories.stories[1]] } };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: /publish video cerita/i });
    expect(await within(card).findByText(/belum ada cerita yang selesai/i)).toBeInTheDocument();
    expect(within(card).getByText(/hubungkan minimal satu platform/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^publish$/i })).toBeDisabled();
  });

  it('a non-admin member sees status but cannot connect or publish', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: true }) };
      if (url === '/api/stories') return { status: 200, body: stories };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl, { user: { ...admin, isAdmin: false } });
    const card = screen.getByRole('region', { name: /platform/i });
    const yt = await within(card).findByRole('listitem', { name: 'YouTube' });
    expect(within(yt).getByRole('button', { name: /putuskan/i })).toBeDisabled();
    expect(screen.getByText(/hanya admin/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
  });
});

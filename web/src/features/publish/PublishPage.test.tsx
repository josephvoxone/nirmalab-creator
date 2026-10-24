import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
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
const NOW = new Date(2026, 9, 24, 10, 0);

function Probe() {
  const { tab } = useParams();
  const location = useLocation();
  const bg = (location.state as { background?: { pathname: string } } | null)?.background?.pathname ?? 'none';
  return <p>settings:{tab}:{bg}</p>;
}

function renderPage(fetchImpl: ReturnType<typeof fakeFetch>, opts: { user?: User } = {}) {
  return render(
    <SessionContext.Provider value={{ user: opts.user ?? admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={['/publish']}>
        <Routes>
          <Route path="/publish" element={<PublishPage now={NOW} />} />
          <Route path="/pengaturan/:tab" element={<Probe />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

const statuses = (connected: Partial<Record<'youtube' | 'tiktok' | 'meta', boolean>>) => ({
  publishers: (['youtube', 'tiktok', 'meta'] as const).map(platform => ({
    platform, configured: true, connected: connected[platform] ?? false,
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

function api(connected: Partial<Record<'youtube' | 'tiktok' | 'meta', boolean>>, extra?: Handler, list: unknown = stories): ReturnType<typeof fakeFetch> {
  return fakeFetch((url, init) => {
    if (url === '/api/publish/status') return { status: 200, body: statuses(connected) };
    if (url === '/api/stories') return { status: 200, body: list };
    return extra?.(url, init) ?? { status: 404, body: {} };
  });
}

const steps = () => screen.getByRole('list', { name: /langkah publish/i });

async function pickStory(title: RegExp) {
  const grid = await screen.findByRole('list', { name: /video selesai/i });
  await userEvent.click(within(grid).getByRole('button', { name: title }));
}

describe('PublishPage (3 steps: Video → Detail → Kirim)', () => {
  it('step 1 shows only finished stories as video posters; later steps are locked; no native selects', async () => {
    renderPage(api({ youtube: true }));
    expect(screen.getByRole('status', { name: /memuat video/i })).toBeInTheDocument();
    const grid = await screen.findByRole('list', { name: /video selesai/i });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
    expect(within(grid).queryByText(/masih render/i)).toBeNull();
    // a real still (server poster, sized), not a black <video#t=1.5>
    expect(grid.querySelector('video')).toBeNull();
    expect(grid.querySelector('img')?.getAttribute('src')).toBe('/api/stories/story_aaaaaaaaaaaaaaaa/video/poster?w=480');
    expect(within(steps()).getByRole('button', { name: /detail/i })).toBeDisabled();
    expect(within(steps()).getByRole('button', { name: /kirim/i })).toBeDisabled();
    expect(document.querySelector('select, input[type="date"], input[type="datetime-local"], input[type="radio"], input[type="checkbox"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /hubungkan/i })).toBeNull();
  });

  it('Detail shows the chosen video as a playable, compact preview stacked above the form on small screens', async () => {
    renderPage(api({ youtube: true }));
    await pickStory(/hujan pertama/i);
    const video = screen.getByLabelText('Pratinjau Hujan Pertama') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video.getAttribute('src')).toBe('/api/stories/story_cccccccccccccccc/video');
    expect(video.getAttribute('poster')).toBe('/api/stories/story_cccccccccccccccc/video/poster?w=480');
    expect(screen.getByRole('button', { name: /layar penuh pratinjau hujan pertama/i })).toBeInTheDocument();
    const preview = video.closest('[data-slot="publish-preview"]') as HTMLElement;
    // never hidden on mobile, never stretched to the form's height
    expect(preview.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(preview.className).toMatch(/self-start/);
  });

  it('picking a video moves to Detail with its title, and lists only connected platforms', async () => {
    renderPage(api({ youtube: true, tiktok: true }));
    await pickStory(/hujan pertama/i);
    expect(within(steps()).getByRole('button', { name: /detail/i })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText('Judul')).toHaveValue('Hujan Pertama');
    const targets = screen.getByRole('group', { name: /platform tujuan/i });
    expect(within(targets).getAllByRole('button').map(b => b.textContent)).toEqual(['YouTube', 'TikTok']);
    expect(within(steps()).getByRole('button', { name: /kirim/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Judul'));
    expect(screen.getByRole('button', { name: /^lanjut/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Judul'), 'Baru');
    for (const b of within(targets).getAllByRole('button')) if (b.getAttribute('aria-pressed') === 'true') await userEvent.click(b);
    expect(screen.getByRole('button', { name: /^lanjut/i })).toBeDisabled();
    await userEvent.click(within(targets).getByRole('button', { name: 'TikTok' }));
    expect(screen.getByRole('button', { name: /^lanjut/i })).toBeEnabled();
  });

  it('starts the caption from the story preview (P4), and leaves it alone when there is none', async () => {
    const caption = 'Hujan turun di teras.\nPayung tertinggal di sekolah.\nIa pulang basah.';
    renderPage(api({ youtube: true }, url => (
      url === '/api/publish/preview/story_cccccccccccccccc'
        ? { status: 200, body: { title: 'Hujan Pertama', caption } }
        : { status: 404, body: {} }
    )));
    await pickStory(/hujan pertama/i);
    await waitFor(() => expect(screen.getByLabelText('Deskripsi')).toHaveValue(caption));
    // A story without a preview (older server, draft) must not prefill anything.
    await userEvent.click(screen.getByRole('button', { name: /kembali/i }));
    await pickStory(/kucing hilang/i);
    await waitFor(() => expect(screen.getByLabelText('Judul')).toHaveValue('Kucing Hilang'));
    expect(screen.getByLabelText('Deskripsi')).toHaveValue(caption);
  });

  it('with no connected platform, Detail says so and opens Settings → Koneksi over the page', async () => {
    renderPage(api({}));
    await pickStory(/kucing hilang/i);
    expect(screen.getByText(/belum ada platform terhubung/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /platform tujuan/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /hubungkan platform/i }));
    expect(await screen.findByText('settings:koneksi:/publish')).toBeInTheDocument();
  });

  it('with no finished story, explains and offers Buat video', async () => {
    renderPage(api({ youtube: true }, undefined, { stories: [stories.stories[1]] }));
    expect(await screen.findByRole('heading', { name: /belum ada video yang selesai/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /buat video/i }));
    expect(await screen.findByText('home')).toBeInTheDocument();
  });

  it('publishes now to every chosen platform and shows a result per platform', async () => {
    const sent: Record<string, unknown> = {};
    renderPage(api({ youtube: true, tiktok: true }, (url, init) => {
      if (url === '/api/publish/youtube/publish' && init?.method === 'POST') {
        sent.youtube = bodyOf(init);
        return { status: 200, body: { ok: true, platform: 'youtube', externalId: 'abc', url: 'https://youtu.be/abc' } };
      }
      if (url === '/api/publish/tiktok/publish' && init?.method === 'POST') {
        sent.tiktok = bodyOf(init);
        return { status: 409, body: { error: { code: 'NEEDS_RECONNECT', message: 'TikTok session expired — reconnect' } } };
      }
      return undefined as never;
    }));
    await pickStory(/hujan pertama/i);
    await userEvent.type(screen.getByLabelText('Judul'), ' #shorts');
    await userEvent.type(screen.getByLabelText('Deskripsi'), 'Cerita pendek');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Visibilitas' })).getByRole('radio', { name: 'Publik' }));
    await userEvent.click(screen.getByRole('button', { name: /^lanjut/i }));
    expect(within(steps()).getByRole('button', { name: /kirim/i })).toHaveAttribute('aria-current', 'step');
    expect(within(screen.getByRole('radiogroup', { name: 'Waktu' })).getByRole('radio', { name: 'Sekarang' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    const results = await screen.findByRole('list', { name: /hasil publish/i });
    const yt = await within(results).findByRole('listitem', { name: 'YouTube' });
    await waitFor(() => expect(within(yt).getByRole('link', { name: /lihat di youtube/i })).toHaveAttribute('href', 'https://youtu.be/abc'));
    const tt = within(results).getByRole('listitem', { name: 'TikTok' });
    await waitFor(() => expect(tt).toHaveTextContent(/sesi tiktok sudah habis/i));
    expect(tt).not.toHaveTextContent('expired');
    expect(sent.youtube).toEqual({ storyId: 'story_cccccccccccccccc', title: 'Hujan Pertama #shorts', description: 'Cerita pendek', visibility: 'public' });
    expect(sent.tiktok).toEqual(sent.youtube);
  });

  it('scheduling is disabled with the reason while TikTok/Meta are chosen', async () => {
    renderPage(api({ youtube: true, tiktok: true, meta: true }));
    await pickStory(/kucing hilang/i);
    await userEvent.click(screen.getByRole('button', { name: /^lanjut/i }));
    const when = screen.getByRole('radiogroup', { name: 'Waktu' });
    expect(within(when).getByRole('radio', { name: 'Jadwalkan' })).toBeDisabled();
    expect(screen.getByText(/jadwal hanya bisa untuk youtube/i)).toHaveTextContent(/tiktok.*meta/i);
    expect(screen.queryByRole('button', { name: /jadwal tayang/i })).toBeNull();
  });

  it('schedules YouTube: publishAt is sent as an ISO string from the date picker', async () => {
    let sent: Record<string, unknown> | undefined;
    renderPage(api({ youtube: true, tiktok: true }, (url, init) => {
      if (url === '/api/publish/youtube/publish') { sent = bodyOf(init); return { status: 200, body: { ok: true, platform: 'youtube', externalId: 'v9', url: 'https://youtu.be/v9' } }; }
      return undefined as never;
    }));
    await pickStory(/kucing hilang/i);
    await userEvent.click(within(screen.getByRole('group', { name: /platform tujuan/i })).getByRole('button', { name: 'TikTok' }));
    await userEvent.click(screen.getByRole('button', { name: /^lanjut/i }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Waktu' })).getByRole('radio', { name: 'Jadwalkan' }));
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /jadwal tayang/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /\b28 Oktober 2026/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(sent).toBeDefined());
    expect(sent?.publishAt).toBe(new Date(2026, 9, 28, 19, 0).toISOString());
    expect(sent?.storyId).toBe('story_aaaaaaaaaaaaaaaa');
  });

  it('a failed load says why and Coba lagi retries', async () => {
    let fail = true;
    renderPage(fakeFetch(url => {
      if (fail) return { status: 500, body: { error: { message: 'boom' } } };
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: true }) };
      if (url === '/api/stories') return { status: 200, body: stories };
      return { status: 404, body: {} };
    }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server sedang bermasalah/i);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await screen.findByRole('list', { name: /video selesai/i })).toBeInTheDocument();
  });

  it('a member can look but not publish', async () => {
    renderPage(api({ youtube: true }), { user: { ...admin, isAdmin: false } });
    await pickStory(/kucing hilang/i);
    await userEvent.click(screen.getByRole('button', { name: /^lanjut/i }));
    expect(screen.getByText(/hanya admin yang bisa publish/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
  });
});

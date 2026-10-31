import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import { ConnectionsPanel } from './ConnectionsPanel.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin: User = { id: 'u1', email: 'joseph@example.com', isAdmin: true };

function renderPanel(fetchImpl: ReturnType<typeof fakeFetch>, opts: { user?: User; openUrl?: (url: string) => void; url?: string } = {}) {
  return render(
    <SessionContext.Provider value={{ user: opts.user ?? admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={[opts.url ?? '/pengaturan/koneksi']}><ConnectionsPanel openUrl={opts.openUrl} /></MemoryRouter>
    </SessionContext.Provider>
  );
}

const statuses = (connected: Partial<Record<'youtube' | 'tiktok' | 'meta', boolean>>) => ({
  publishers: (['youtube', 'tiktok', 'meta'] as const).map(platform => ({
    platform,
    configured: platform !== 'meta',
    connected: connected[platform] ?? false,
    missingEnv: platform === 'meta' ? ['OPENCREATOR_PUBLISHER_META_APP_ID', 'OPENCREATOR_PUBLISHER_META_APP_SECRET'] : [],
    ...(connected[platform] ? { accountLabel: `${platform}-channel` } : {})
  }))
});

const section = () => screen.getByRole('region', { name: /koneksi platform/i });

describe('ConnectionsPanel (Settings → Koneksi)', () => {
  it('shows a skeleton, then one row per platform with its status and action', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ youtube: true }) } : { status: 404, body: {} });
    renderPanel(fetchImpl);
    expect(within(section()).getByRole('status', { name: /memuat koneksi/i })).toBeInTheDocument();
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    expect(yt).toHaveTextContent('Terhubung sebagai youtube-channel');
    expect(within(yt).getByRole('button', { name: /putuskan/i })).toBeEnabled();
    const tt = within(section()).getByRole('listitem', { name: 'TikTok' });
    expect(tt).toHaveTextContent('Belum terhubung');
    expect(within(tt).getByRole('button', { name: /hubungkan/i })).toBeEnabled();
    const meta = within(section()).getByRole('listitem', { name: 'Meta' });
    expect(meta).toHaveTextContent('Belum dikonfigurasi');
    expect(meta).toHaveTextContent(/OPENCREATOR_PUBLISHER_META_APP_ID dan OPENCREATOR_PUBLISHER_META_APP_SECRET/);
    expect(within(meta).queryByRole('button', { name: /hubungkan/i })).toBeNull();
  });

  it('Hubungkan asks the server for the OAuth URL and opens it', async () => {
    const openUrl = vi.fn();
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({}) };
      if (url === '/api/publish/tiktok/connect' && init?.method === 'POST') return { status: 200, body: { url: 'https://www.tiktok.com/v2/auth/authorize?x=1', state: 's' } };
      return { status: 404, body: {} };
    });
    renderPanel(fetchImpl, { openUrl });
    const tt = await within(section()).findByRole('listitem', { name: 'TikTok' });
    await userEvent.click(within(tt).getByRole('button', { name: /hubungkan/i }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://www.tiktok.com/v2/auth/authorize?x=1'));
  });

  it('a failed connect shows the cause in plain words', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({}) };
      if (url === '/api/publish/youtube/connect') return { status: 409, body: { error: { code: 'X', message: 'YouTube client belum diatur' } } };
      return { status: 404, body: {} };
    });
    renderPanel(fetchImpl, { openUrl: vi.fn() });
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    await userEvent.click(within(yt).getByRole('button', { name: /hubungkan/i }));
    expect(await within(section()).findByRole('alert')).toHaveTextContent('YouTube client belum diatur');
  });

  it('Putuskan asks for confirmation first; cancel keeps it, confirm disconnects and refreshes', async () => {
    let ytConnected = true;
    const disconnect = vi.fn();
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/publish/status') return { status: 200, body: statuses({ youtube: ytConnected }) };
      if (url === '/api/publish/youtube/disconnect' && init?.method === 'POST') { disconnect(); ytConnected = false; return { status: 200, body: { ok: true } }; }
      return { status: 404, body: {} };
    });
    renderPanel(fetchImpl);
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    await userEvent.click(within(yt).getByRole('button', { name: /putuskan/i }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/youtube-channel/);
    await userEvent.click(within(dialog).getByRole('button', { name: /batal/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();

    await userEvent.click(within(yt).getByRole('button', { name: /putuskan/i }));
    dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^putuskan/i }));
    await waitFor(() => expect(within(section()).getByRole('listitem', { name: 'YouTube' })).toHaveTextContent('Belum terhubung'));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('a member sees the status only, no actions', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ youtube: true }) } : { status: 404, body: {} });
    renderPanel(fetchImpl, { user: { ...admin, isAdmin: false } });
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    expect(yt).toHaveTextContent('Terhubung sebagai youtube-channel');
    expect(within(section()).queryByRole('button', { name: /putuskan|hubungkan/i })).toBeNull();
    expect(within(section()).getByText(/hanya admin/i)).toBeInTheDocument();
  });

  it('a failed load says why and Coba lagi reloads', async () => {
    let fail = true;
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/publish/status') return fail ? { status: 500, body: { error: { message: 'boom' } } } : { status: 200, body: statuses({}) };
      return { status: 404, body: {} };
    });
    renderPanel(fetchImpl);
    const alert = await within(section()).findByRole('alert');
    expect(alert).toHaveTextContent(/server sedang bermasalah/i);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(section()).findByRole('listitem', { name: 'YouTube' })).toBeInTheDocument();
  });

  it('after the OAuth round trip, ?connected=PLATFORM shows a success notice', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ youtube: true }) } : { status: 404, body: {} });
    renderPanel(fetchImpl, { url: '/pengaturan/koneksi?connected=youtube' });
    expect(await within(section()).findByRole('status', { name: /hasil koneksi/i })).toHaveTextContent('YouTube berhasil terhubung');
  });

  it('?error=MESSAGE shows the failure in a notice', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    const message = 'Izin akses ditolak di TikTok. Coba hubungkan lagi dan setujui izinnya.';
    renderPanel(fetchImpl, { url: `/pengaturan/koneksi?platform=tiktok&error=${encodeURIComponent(message)}` });
    const notice = await within(section()).findByRole('alert');
    expect(notice).toHaveTextContent('TikTok gagal terhubung');
    expect(notice).toHaveTextContent(message);
  });

  // ---- T7.6: every user connects their own accounts -------------------------------------------------------------

  it('says the connections are the user\'s own: other people neither see nor use them', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    renderPanel(fetchImpl);
    await within(section()).findByRole('listitem', { name: 'YouTube' });
    expect(within(section()).getByText(/koneksi ini milikmu sendiri/i)).toHaveTextContent(/pengguna lain tidak (bisa )?(melihat|memakai)/i);
  });

  it('empty state: with nothing connected it says so and points at Hubungkan (plain Indonesian)', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    renderPanel(fetchImpl);
    await within(section()).findByRole('listitem', { name: 'YouTube' });
    expect(within(section()).getByText(/belum ada akun yang kamu hubungkan/i)).toBeInTheDocument();
  });

  it('the empty note disappears as soon as one platform is connected', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ tiktok: true }) } : { status: 404, body: {} });
    renderPanel(fetchImpl);
    await within(section()).findByRole('listitem', { name: 'TikTok' });
    expect(within(section()).queryByText(/belum ada akun yang kamu hubungkan/i)).toBeNull();
  });

  it('two admins, two sessions: each panel shows only the account that user connected', async () => {
    const mine = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ youtube: true }) } : { status: 404, body: {} });
    const other = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    const first = renderPanel(mine);
    expect(await within(section()).findByRole('listitem', { name: 'YouTube' })).toHaveTextContent('Terhubung sebagai youtube-channel');
    first.unmount();
    renderPanel(other, { user: { id: 'u2', email: 'bina@example.com', isAdmin: true } });
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    expect(yt).toHaveTextContent('Belum terhubung');
    expect(section()).not.toHaveTextContent('youtube-channel');
    expect(within(yt).getByRole('button', { name: /hubungkan/i })).toBeEnabled();
    // each panel only ever asks for its own list: no user id or platform-wide query goes out
    expect(other.mock.calls.map(call => call[0])).toEqual(['/api/publish/status']);
  });

  it('a callback refused because the link belongs to another account shows that plain message', async () => {
    const message = 'Tautan ini dimulai dari akun lain. Masuk dengan akun yang menghubungkan YouTube, lalu coba lagi.';
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    renderPanel(fetchImpl, { url: `/pengaturan/koneksi?platform=youtube&error=${encodeURIComponent(message)}` });
    const notice = await within(section()).findByRole('alert', { name: /hasil koneksi/i });
    expect(notice).toHaveTextContent('YouTube gagal terhubung');
    expect(notice).toHaveTextContent(message);
  });

  it('a member sees plain words for a platform the server has no app for, not env var names', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({}) } : { status: 404, body: {} });
    renderPanel(fetchImpl, { user: { ...admin, isAdmin: false } });
    const meta = await within(section()).findByRole('listitem', { name: 'Meta' });
    expect(meta).toHaveTextContent(/belum disiapkan di server/i);
    expect(meta).toHaveTextContent(/minta admin/i);
    expect(meta.textContent).not.toMatch(/OPENCREATOR_/);
  });

  it('the disconnect dialog says it only affects your own connection', async () => {
    const fetchImpl = fakeFetch(url => url === '/api/publish/status' ? { status: 200, body: statuses({ youtube: true }) } : { status: 404, body: {} });
    renderPanel(fetchImpl);
    const yt = await within(section()).findByRole('listitem', { name: 'YouTube' });
    await userEvent.click(within(yt).getByRole('button', { name: /putuskan/i }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/koneksi pengguna lain tidak terpengaruh/i);
  });
});

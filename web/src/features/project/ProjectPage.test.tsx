import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';

describe('Project page shell', () => {
  it('shows title, logline, the production stage bar and the tabs; no ComfyUI graph', async () => {
    const api = fakeProjectApi();
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    expect(await screen.findByRole('heading', { name: 'Jingga di Pagar' })).toBeInTheDocument();
    expect(screen.getByText(/kucing oranye menunggu/i)).toBeInTheDocument();
    const stages = screen.getByRole('list', { name: /tahap produksi/i });
    expect(within(stages).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Naskah', 'Breakdown', 'Keyframe', 'Render', 'Rakit']);
    expect(within(stages).getByRole('listitem', { name: 'Render' })).toHaveAttribute('aria-current', 'step');
    const tabs = screen.getByRole('tablist', { name: /bagian proyek/i });
    expect(within(tabs).getAllByRole('tab').map(t => t.textContent?.replace(/\d+/g, '').trim())).toEqual(['Scene', 'Breakdown', 'Timeline', 'Hasil', 'Aktivitas']);
    expect(document.querySelector('.flow-canvas, [data-testid="flow-canvas"]')).toBeNull();
  });

  it('remembers the tab in the URL (?tab=)', async () => {
    const api = fakeProjectApi();
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
    expect(await screen.findByRole('tab', { name: /breakdown/i })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: /aktivitas/i }));
    expect(screen.getByRole('tab', { name: /aktivitas/i })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/keyframe siap untuk direview/i)).toBeInTheDocument();
  });

  it('renames the project inline', async () => {
    const api = fakeProjectApi();
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /ubah judul/i }));
    const input = screen.getByRole('textbox', { name: /judul proyek/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'Jingga Pulang{Enter}');
    await waitFor(() => expect(api.calls.some(c => c.method === 'PUT' && c.body?.storyboard && (c.body.storyboard as { title: string }).title === 'Jingga Pulang')).toBe(true));
  });

  it('offers render-anyway after a budget refusal', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'done', 'done']), fail: { render: { status: 402, message: 'Butuh ±40 credits, tersisa 3', code: 'BUDGET' } } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await userEvent.click(await screen.findByRole('button', { name: /render semua/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/tersisa 3/);
    expect(within(alert).getByRole('button', { name: /render tetap/i })).toBeInTheDocument();
  });

  it('skeleton while loading; a network failure offers retry and recovers', async () => {
    const api = fakeProjectApi({ fail: { get: { status: 503, message: 'Server sibuk' } } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    expect(screen.getByLabelText(/memuat proyek/i)).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('heading', { name: /proyek gagal dimuat/i })).toBeInTheDocument();
    const retry = api.fetchImpl.getMockImplementation()!;
    api.fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => (url === `/api/stories/${ID}` && (init?.method ?? 'GET') === 'GET'
      ? new Response(JSON.stringify({ story: storyFor(BOARD), storyboard: BOARD }), { status: 200, headers: { 'content-type': 'application/json' } })
      : retry(url, init)));
    await userEvent.click(screen.getByRole('button', { name: /coba lagi/i }));
    expect(await screen.findByRole('heading', { name: 'Jingga di Pagar' })).toBeInTheDocument();
  });

  it('polls while working, keeps content when a refresh fails, and shows the finished state', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'queued', 'pending', 'pending'], { status: 'rendering' }) });
    mountProject(<ProjectPage pollMs={30} />, api.fetchImpl);
    expect(await screen.findByRole('button', { name: /merender/i })).toBeDisabled();
    const base = api.fetchImpl.getMockImplementation()!;
    api.fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => (url === `/api/stories/${ID}` ? new Response('{}', { status: 502 }) : base(url, init)));
    expect(await screen.findByText(/pembaruan status gagal dimuat/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Jingga di Pagar' })).toBeInTheDocument();
    api.story = storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done'], { status: 'done', video: { bytes: 2_000_000, finishedAtMs: 5 } });
    api.fetchImpl.mockImplementation(base);
    expect(await screen.findByRole('link', { name: /publish/i })).toHaveAttribute('href', '/publish');
    expect(within(screen.getByRole('list', { name: /tahap produksi/i })).getByRole('listitem', { name: 'Rakit' })).toHaveAttribute('aria-current', 'step');
  });

  it('a failed story says why and retries', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'failed', 'pending', 'pending'], { status: 'failed', error: 'Flow menolak prompt shot 2' }) });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    expect(await screen.findByRole('alert')).toHaveTextContent(/flow menolak prompt shot 2/i);
    await userEvent.click(screen.getByRole('button', { name: /ulangi yang gagal/i }));
    await waitFor(() => expect(api.calls.some(c => c.url === `/api/stories/${ID}/retry`)).toBe(true));
  });

  it('not found, and load error with retry', async () => {
    const missing = fakeProjectApi({ fail: { get: { status: 404, message: 'Story not found' } } });
    mountProject(<ProjectPage pollMs={0} />, missing.fetchImpl);
    expect(await screen.findByRole('heading', { name: /proyek tidak ditemukan/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /kembali ke proyek/i })).toHaveAttribute('href', '/cerita');
  });
});

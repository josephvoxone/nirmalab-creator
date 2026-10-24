import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';

const open = (api: ReturnType<typeof fakeProjectApi>) => mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=hasil` });
const ALL = ['done', 'done', 'done', 'done'];
const posted = (api: ReturnType<typeof fakeProjectApi>, path: string) => api.calls.some(c => c.method === 'POST' && c.url === `/api/stories/${ID}/${path}`);
const panel = () => screen.getByRole('tabpanel');

describe('Hasil tab', () => {
  it('shows the final video small with size, finish time, download; one Publish (header)', async () => {
    const finishedAtMs = new Date(2026, 9, 24, 14, 5).getTime();
    open(fakeProjectApi({ story: storyFor(BOARD, ALL, ALL, { status: 'done', video: { bytes: 2_000_000, finishedAtMs } }) }));
    const video = await screen.findByLabelText('Video akhir');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', expect.stringContaining(`/api/stories/${ID}/video`));
    expect(video.style.maxHeight).toBe('320px');
    expect(within(panel()).getByRole('button', { name: /layar penuh video akhir/i })).toBeInTheDocument();
    expect(panel()).toHaveTextContent('1,9 MB');
    expect(panel()).toHaveTextContent(/24 Okt 2026/);
    const download = within(panel()).getByRole('link', { name: /unduh/i });
    expect(download).toHaveAttribute('href', `/api/stories/${ID}/video`);
    expect(download).toHaveAttribute('download');
    // Publish lives once, in the project header (the next step when the video is done).
    expect(within(panel()).queryByRole('link', { name: /publish/i })).toBeNull();
    expect(screen.getAllByRole('link', { name: /publish/i })).toHaveLength(1);
    expect(within(panel()).queryByRole('button', { name: /rakit/i })).not.toBeInTheDocument();
  });

  // Project-wide actions live once, in the header ("the one next step"); the tab only says what it is.
  const header = () => screen.getByRole('heading', { name: 'Jingga di Pagar' }).closest('div')!.parentElement!.parentElement!;
  const noGlobalButtons = () => expect(within(panel()).queryByRole('button', { name: /render sisa|render semua|rakit|buat keyframe|ulangi/i })).toBeNull();

  it('stale video: the tab says so; the one Rakit ulang is the header action', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ALL, ALL, { status: 'review', video: { bytes: 2_000_000, finishedAtMs: 5 }, videoStale: true }) });
    open(api);
    await screen.findByLabelText('Video akhir');
    expect(panel()).toHaveTextContent(/video ini belum mengikuti urutan terbaru/i);
    noGlobalButtons();
    expect(screen.getAllByRole('button', { name: /rakit ulang/i })).toHaveLength(1);
    await userEvent.click(within(header()).getByRole('button', { name: /rakit ulang video/i }));
    await waitFor(() => expect(posted(api, 'assemble')).toBe(true));
  });

  it('without a final video: progress, per-scene status, and the next step named (run from the header)', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ALL, ['done', 'pending', 'failed', 'pending']) });
    open(api);
    expect(await screen.findByText(/video akhir belum dirakit/i)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(/1\/4 klip selesai/);
    expect(within(panel()).getByRole('progressbar')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: /scene/i })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/menunggu/i);
    expect(rows[0]).toHaveTextContent(/1\/2 klip/);
    expect(rows[1]).toHaveTextContent(/0\/2 klip/);
    expect(rows[1]).toHaveTextContent(/1 gagal/);
    expect(within(panel()).queryByRole('link', { name: /unduh/i })).not.toBeInTheDocument();
    expect(panel()).toHaveTextContent(/langkah berikutnya: render/i);
    noGlobalButtons();
    await userEvent.click(within(header()).getByRole('button', { name: /render semua · ±30 kredit/i }));
    await waitFor(() => expect(posted(api, 'render')).toBe(true));
  });

  it('all clips done but no video: the next step is assembling', async () => {
    open(fakeProjectApi({ story: storyFor(BOARD, ALL, ALL) }));
    expect(await screen.findByText(/4\/4 klip selesai/i)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(/langkah berikutnya: rakit video/i);
    noGlobalButtons();
  });

  it('keyframes still missing (konsisten): the next step is keyframes, free', async () => {
    open(fakeProjectApi({ story: storyFor(BOARD, ['done', 'pending', 'pending', 'pending']) }));
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveTextContent(/langkah berikutnya: buat keyframe/i));
    noGlobalButtons();
  });

  it('while rendering, the tab says it is working', async () => {
    open(fakeProjectApi({ story: storyFor(BOARD, ALL, ['done', 'queued', 'queued', 'pending'], { status: 'rendering' }) }));
    expect(await within(await screen.findByRole('tabpanel')).findByText(/sedang merender/i)).toBeInTheDocument();
  });

  it('Putar scene opens a small dialog that plays only that scene', async () => {
    open(fakeProjectApi({ story: storyFor(BOARD, ALL, ['done', 'pending', 'pending', 'pending']) }));
    const rows = within(await screen.findByRole('list', { name: /scene/i })).getAllByRole('listitem');
    await userEvent.click(within(rows[1]!).getByRole('button', { name: /putar scene/i }));
    const dialog = await screen.findByRole('dialog', { name: /pulang/i });
    const player = within(dialog).getByRole('group', { name: /preview scene pulang/i });
    expect(player).toHaveTextContent(/1\/2 · shot 3 · pulang/i);
    expect((player.firstElementChild as HTMLElement).style.height).toBe('300px');
  });

  it('empty project: nothing to show yet', async () => {
    const empty = { ...BOARD, scenes: [{ id: 'scene-1', title: 'Scene 1', shots: [] }], shots: [] };
    open(fakeProjectApi({ board: empty, story: storyFor(empty) }));
    expect(await screen.findByText(/belum ada shot/i)).toBeInTheDocument();
  });
});

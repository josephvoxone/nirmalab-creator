import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor, type Call } from './testkit.js';

const open = (api: ReturnType<typeof fakeProjectApi>) => mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=timeline` });
const track = (name: RegExp) => screen.getByRole('list', { name });
const lastPut = (calls: Call[]) => calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as { scenes: Array<{ id: string; shots: string[] }> } | undefined;
const order = (calls: Call[]) => lastPut(calls)?.scenes.map(s => `${s.id}:${s.shots.join(',')}`).join(' | ');

describe('Timeline tab', () => {
  it('shows a program monitor above scene, video and narration tracks on one time ruler', async () => {
    const story = storyFor(BOARD, [], ['done', 'pending', 'pending', 'pending']);
    story.shots[0]!.durationSec = 12;
    open(fakeProjectApi({ story }));
    const monitor = await screen.findByRole('group', { name: /program monitor/i });
    expect(within(monitor).getByText(/1\/4/)).toBeInTheDocument();
    expect(within(monitor).getByLabelText(/shot 1 · menunggu/i).tagName).toBe('VIDEO');

    const ruler = screen.getByRole('list', { name: /ruler/i });
    expect(within(ruler).getAllByRole('listitem').map(li => li.textContent)).toEqual(['0:00', '0:06', '0:12', '0:18', '0:24', '0:30']);

    const scenes = track(/track scene/i);
    expect(within(scenes).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('Menunggu'), expect.stringContaining('Pulang')]);

    const clips = within(track(/track video v1/i)).getAllByRole('button', { name: /^shot \d/i });
    expect(clips.map(c => c.getAttribute('aria-label'))).toEqual(['Shot 1: 00-pembuka', 'Shot 2: 01-pagar', 'Shot 3: 02-jalan', 'Shot 4: 03-peluk']);
    // width follows duration: 12 s is twice a 6 s clip
    expect(parseFloat(clips[0]!.style.width)).toBe(2 * parseFloat(clips[1]!.style.width));
    expect(clips[0]).toHaveAttribute('data-status', 'done');
    expect(clips[1]).toHaveAttribute('data-status', 'pending');
    expect(within(clips[1]!).getByRole('img')).toHaveAttribute('src', expect.stringContaining(`/shots/01-pagar/frame`));

    const narration = within(track(/track narasi a1/i)).getAllByRole('listitem').map(li => li.textContent);
    expect(narration).toEqual(['—', 'Jingga menunggu setiap sore.', 'Suatu hari Bima pulang.', 'Mereka bertemu lagi.']);
  });

  it('zoom changes px per second', async () => {
    open(fakeProjectApi());
    const first = () => within(track(/track video v1/i)).getAllByRole('button', { name: /^shot \d/i })[0]!;
    await screen.findByRole('group', { name: /program monitor/i });
    const base = parseFloat(first().style.width);
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Zoom' })).getByRole('radio', { name: '200%' }));
    expect(parseFloat(first().style.width)).toBe(base * 2);
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Zoom' })).getByRole('radio', { name: '50%' }));
    expect(parseFloat(first().style.width)).toBe(base / 2);
  });

  it('clicking a clip selects it, jumps the monitor there, and the playing clip is highlighted', async () => {
    open(fakeProjectApi());
    const monitor = await screen.findByRole('group', { name: /program monitor/i });
    const clip = (n: number) => within(track(/track video v1/i)).getByRole('button', { name: new RegExp(`^shot ${n}:`, 'i') });
    expect(clip(1)).toHaveAttribute('aria-current', 'true');
    await userEvent.click(clip(3));
    expect(clip(3)).toHaveAttribute('aria-pressed', 'true');
    expect(within(monitor).getByText(/3\/4 · shot 3 · pulang/i)).toBeInTheDocument();
    expect(clip(3)).toHaveAttribute('aria-current', 'true');
    expect(clip(1)).not.toHaveAttribute('aria-current');
    await userEvent.click(within(monitor).getByRole('button', { name: /shot berikutnya/i }));
    expect(clip(4)).toHaveAttribute('aria-current', 'true');

    const inspector = screen.getByRole('region', { name: /inspector/i });
    expect(inspector).toHaveTextContent(/pulang/i);
    expect(inspector).toHaveTextContent(/6 dtk/);
    expect(inspector).toHaveTextContent(/suatu hari bima pulang/i);
    expect(inspector).toHaveTextContent(/belum dirender/i);
  });

  it('Geser kiri/kanan reorders through the board (crossing a scene edge moves the shot into that scene)', async () => {
    const api = fakeProjectApi();
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    await userEvent.click(within(track(/track video v1/i)).getByRole('button', { name: /^shot 2:/i }));
    const inspector = screen.getByRole('region', { name: /inspector/i });
    expect(within(inspector).getByRole('button', { name: /geser kiri/i })).toBeEnabled();
    await userEvent.click(within(inspector).getByRole('button', { name: /geser kanan/i }));
    await waitFor(() => expect(order(api.calls)).toBe('menunggu:00-pembuka | pulang:01-pagar,02-jalan,03-peluk'));
    // selection follows the shot
    expect(within(track(/track video v1/i)).getByRole('button', { name: /^shot 2: 01-pagar/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: /inspector/i })).toHaveTextContent(/scene\s*pulang/i);
  });

  it('first shot cannot move left; Pindah ke scene moves it to the end of another scene', async () => {
    const api = fakeProjectApi();
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    await userEvent.click(within(track(/track video v1/i)).getByRole('button', { name: /^shot 1:/i }));
    const inspector = screen.getByRole('region', { name: /inspector/i });
    expect(within(inspector).getByRole('button', { name: /geser kiri/i })).toBeDisabled();
    await userEvent.click(within(inspector).getByRole('button', { name: /pindah ke scene/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /menunggu/i })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: /pulang/i }));
    await waitFor(() => expect(order(api.calls)).toBe('menunggu:01-pagar | pulang:02-jalan,03-peluk,00-pembuka'));
  });

  it('a scene band selects the scene; its Geser buttons reorder scenes', async () => {
    const api = fakeProjectApi();
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    await userEvent.click(within(track(/track scene/i)).getByRole('button', { name: /scene pulang/i }));
    const inspector = screen.getByRole('region', { name: /inspector/i });
    expect(inspector).toHaveTextContent(/2 shot/);
    expect(within(inspector).getByRole('button', { name: /geser kanan/i })).toBeDisabled();
    await userEvent.click(within(inspector).getByRole('button', { name: /geser kiri/i }));
    await waitFor(() => expect(order(api.calls)).toBe('pulang:02-jalan,03-peluk | menunggu:00-pembuka,01-pagar'));
    expect(within(track(/track scene/i)).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('Pulang'), expect.stringContaining('Menunggu')]);
  });

  it('after a reorder with an assembled video the banner explains and the ONE Rakit ulang (header) assembles', async () => {
    const all = ['done', 'done', 'done', 'done'];
    const api = fakeProjectApi({ story: storyFor(BOARD, all, all, { status: 'done', video: { bytes: 2_000_000, finishedAtMs: 5 } }) });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    expect(screen.queryByText(/rakit ulang/i)).not.toBeInTheDocument();
    await userEvent.click(within(track(/track video v1/i)).getByRole('button', { name: /^shot 1:/i }));
    await userEvent.click(within(screen.getByRole('region', { name: /inspector/i })).getByRole('button', { name: /geser kanan/i }));
    const banner = await screen.findByText(/urutan atau isi berubah sejak video dirakit/i);
    expect(screen.queryByText(/urutan berubah — rakit ulang/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel').textContent).not.toMatch(/rakit ulang/i);
    expect(within(banner.closest('[role="status"]') as HTMLElement).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: /rakit ulang/i })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /rakit ulang video/i }));
    await waitFor(() => expect(api.calls.some(c => c.method === 'POST' && c.url === `/api/stories/${ID}/assemble`)).toBe(true));
  });

  it('durations from ffprobe are rounded in the inspector and tooltips', async () => {
    const story = storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'pending', 'pending', 'pending']);
    story.shots[0]!.durationSec = 6.016;
    const api = fakeProjectApi({ story });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    const first = within(track(/track video v1/i)).getByRole('button', { name: /^shot 1:/i });
    await userEvent.click(first);
    expect(screen.getByRole('region', { name: /inspector/i }).textContent).not.toMatch(/\d\.\d+ dtk/);
    expect(first.getAttribute('title')).not.toMatch(/\d\.\d+ dtk/);
  });

  it('empty state when there are no shots', async () => {
    const empty = { ...BOARD, scenes: [{ id: 'scene-1', title: 'Scene 1', shots: [] }], shots: [] };
    open(fakeProjectApi({ board: empty, story: storyFor(empty) }));
    expect(await screen.findByText(/belum ada shot di timeline/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /program monitor/i })).not.toBeInTheDocument();
  });
});

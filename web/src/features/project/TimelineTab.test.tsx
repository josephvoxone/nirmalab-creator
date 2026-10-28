import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor, type Call, type ExtraRoute } from './testkit.js';
import { clipWindow, timelineLayout } from './TimelineModel.js';

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
    expect(within(clips[1]!).getByRole('img')).toHaveAttribute('src', expect.stringMatching(/\/shots\/01-pagar\/frame\?.*w=160$/));
    expect(within(clips[1]!).getByRole('img')).toHaveAttribute('decoding', 'async');

    const narration = within(track(/track subtitle t1/i)).getAllByRole('listitem').map(li => li.textContent);
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

type Edit = { clipVolume?: number; subtitles?: boolean; subtitleStyle?: string; music?: { file: string; name: string; seconds: number; volume: number; at: number; from?: number } };
const lastBoard = (calls: Call[]) => calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as { edit?: Edit; shots: Array<{ id: string; trim?: { in?: number; out?: number } }> } | undefined;
const allDone = () => storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']);

describe('Timeline model: trim', () => {
  it('a clip plays its In..Out window, never shorter than 1 s, the Out point stays (same rule as the assembler)', () => {
    expect(clipWindow(undefined, 5.04)).toEqual({ start: 0, seconds: 5.04 });
    expect(clipWindow({ in: 0.5, out: 4 }, 5.04)).toEqual({ start: 0.5, seconds: 3.5 });
    expect(clipWindow({ in: 1, out: 9 }, 5)).toEqual({ start: 1, seconds: 4 });
    expect(clipWindow({ in: 4.8, out: 4.9 }, 5)).toEqual({ start: 3.9, seconds: 1 });
  });

  it('the layout uses the trimmed length', () => {
    const story = allDone();
    story.shots[0]!.durationSec = 6;
    const board = { ...BOARD, shots: BOARD.shots.map((s, i) => (i === 0 ? { ...s, trim: { in: 1, out: 4 } } : s)) };
    const l = timelineLayout(board, story);
    expect(l.clips[0]).toMatchObject({ seconds: 3, trimIn: 1, full: 6 });
    expect(l.clips[1]!.start).toBe(3);
  });
});

describe('Timeline edit (Premiere-style)', () => {
  it('trim: In/Out in the inspector save shot.trim; the clip narrows; Reset removes it', async () => {
    const story = allDone();
    story.shots[0]!.durationSec = 6;
    const api = fakeProjectApi({ story });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    const first = () => within(track(/track video v1/i)).getByRole('button', { name: /^shot 1:/i });
    const full = parseFloat(first().style.width);
    await userEvent.click(first());
    const inspector = screen.getByRole('region', { name: /inspector/i });
    const inField = within(inspector).getByRole('textbox', { name: 'Trim awal (detik)' });
    await userEvent.clear(inField);
    await userEvent.type(inField, '1,5{Enter}');
    await waitFor(() => expect(lastBoard(api.calls)?.shots[0]!.trim).toEqual({ in: 1.5 }));
    await waitFor(() => expect(parseFloat(first().style.width)).toBeCloseTo(full * 4.5 / 6, 3));
    await userEvent.click(within(screen.getByRole('region', { name: /inspector/i })).getByRole('button', { name: 'Tambah 0,1 detik Trim akhir (detik)' }));
    await waitFor(() => expect(lastBoard(api.calls)?.shots[0]!.trim).toEqual({ in: 1.5 }));
    await userEvent.click(within(screen.getByRole('region', { name: /inspector/i })).getByRole('button', { name: 'Kurangi 0,1 detik Trim akhir (detik)' }));
    await waitFor(() => expect(lastBoard(api.calls)?.shots[0]!.trim).toEqual({ in: 1.5, out: 5.9 }));
    await userEvent.click(within(screen.getByRole('region', { name: /inspector/i })).getByRole('button', { name: /reset trim/i }));
    await waitFor(() => expect(lastBoard(api.calls)?.shots[0]!.trim).toBeUndefined());
  });

  it('trim handles on the clip edges move with the keyboard and save once you stop', async () => {
    const story = allDone();
    story.shots[1]!.durationSec = 6;
    const api = fakeProjectApi({ story });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    const handle = within(track(/track video v1/i)).getByRole('slider', { name: 'Trim awal shot 2' });
    expect(handle).toHaveAttribute('aria-valuenow', '0');
    handle.focus();
    for (let i = 0; i < 5; i++) await userEvent.keyboard('{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '0.5');
    await waitFor(() => expect(lastBoard(api.calls)?.shots[1]!.trim).toEqual({ in: 0.5 }), { timeout: 2000 });
    expect(api.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('subtitles: the switch saves edit.subtitles and the monitor shows the current line', async () => {
    const api = fakeProjectApi({ story: allDone() });
    open(api);
    const monitor = await screen.findByRole('group', { name: /program monitor/i });
    expect(within(monitor).queryByTestId('caption')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Subtitle di video' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ subtitles: true }));
    await userEvent.click(within(track(/track video v1/i)).getByRole('button', { name: /^shot 2:/i }));
    expect(await within(monitor).findByTestId('caption')).toHaveTextContent('Jingga menunggu setiap sore.');
  });

  it('subtitles: "Tulisan tangan" saves edit.subtitleStyle and the monitor letters the line by hand', async () => {
    const api = fakeProjectApi({ story: allDone() });
    open(api);
    const monitor = await screen.findByRole('group', { name: /program monitor/i });
    expect(screen.queryByRole('radiogroup', { name: 'Gaya subtitle' })).toBeNull();      // only once subtitles are on
    await userEvent.click(screen.getByRole('switch', { name: 'Subtitle di video' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ subtitles: true }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Gaya subtitle' })).getByRole('radio', { name: 'Tulisan tangan' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ subtitles: true, subtitleStyle: 'tulisan-tangan' }));
    await userEvent.click(within(track(/track video v1/i)).getByRole('button', { name: /^shot 2:/i }));
    expect(await within(monitor).findByTestId('caption')).toHaveAttribute('data-style', 'tulisan-tangan');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Gaya subtitle' })).getByRole('radio', { name: 'Biasa' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ subtitles: true }));
  });

  it('music: upload → POST /music → saved on the board → A2 bar; start, volume and Hapus edit it', async () => {
    const music: ExtraRoute = (call, json) => (call.method === 'POST' && call.url === `/api/stories/${ID}/music`
      ? json(201, { file: 'music.mp3', name: 'Kidung Malam.mp3', seconds: 95.2 }) : undefined);
    const api = fakeProjectApi({ story: allDone(), extra: music });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    const input = screen.getByLabelText('Pilih berkas musik') as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([0x49, 0x44, 0x33, 4])], 'Kidung Malam.mp3', { type: 'audio/mpeg' }));
    const post = await waitFor(() => { const c = api.calls.find(x => x.method === 'POST' && x.url === `/api/stories/${ID}/music`); expect(c).toBeDefined(); return c!; });
    expect(post.headers).toMatchObject({ 'Content-Type': 'audio/mpeg', 'X-File-Name': 'Kidung%20Malam.mp3' });
    await waitFor(() => expect(lastBoard(api.calls)?.edit?.music).toEqual({ file: 'music.mp3', name: 'Kidung Malam.mp3', seconds: 95.2, volume: 0.35, at: 0 }));

    const bar = await within(track(/track musik a2/i)).findByRole('button', { name: 'Musik: Kidung Malam.mp3' });
    await userEvent.click(bar);
    const inspector = screen.getByRole('region', { name: /inspector/i });
    const at = within(inspector).getByRole('textbox', { name: 'Mulai di timeline (detik)' });
    await userEvent.clear(at);
    await userEvent.type(at, '2{Enter}');
    await waitFor(() => expect(lastBoard(api.calls)?.edit?.music?.at).toBe(2));
    const volume = within(screen.getByRole('region', { name: /inspector/i })).getByLabelText('Volume musik');
    volume.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(lastBoard(api.calls)?.edit?.music?.volume).toBe(0.4));
    await userEvent.click(within(screen.getByRole('region', { name: /inspector/i })).getByRole('button', { name: 'Hapus musik' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit?.music).toBeUndefined());
  });

  it('clip sound: A1 opens its volume; the slider saves edit.clipVolume', async () => {
    const api = fakeProjectApi({ story: allDone() });
    open(api);
    await screen.findByRole('group', { name: /program monitor/i });
    await userEvent.click(screen.getByRole('button', { name: 'Suara klip A1' }));
    const volume = within(screen.getByRole('region', { name: /inspector/i })).getByLabelText('Volume suara klip');
    expect(volume).toHaveAttribute('aria-valuenow', '1');
    volume.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(lastBoard(api.calls)?.edit?.clipVolume).toBe(0.9));
  });
});

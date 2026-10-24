import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import type { Board } from './model.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';

type Api = ReturnType<typeof fakeProjectApi>;

async function open(api: Api) {
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
  return screen.findByRole('list', { name: /daftar scene/i });
}
const puts = (api: Api) => api.calls.filter(c => c.method === 'PUT').map(c => c.body!.storyboard as Board);
const lastPut = async (api: Api) => { await waitFor(() => expect(puts(api).length).toBeGreaterThan(0)); return puts(api).at(-1)!; };
const layout = (b: Board) => b.scenes!.map(s => `${s.id}:${s.shots.join(',')}`);
const board = () => screen.getByRole('region', { name: /^Scene / });
const grid = () => within(board()).getByRole('list', { name: /shot di scene/i });
const card = (id: string) => within(grid()).getByRole('listitem', { name: new RegExp(`· ${id}$`) });
async function menuItem(trigger: HTMLElement, name: RegExp) {
  await userEvent.click(trigger);
  const menu = await screen.findByRole('menu');
  return within(menu).getByRole('menuitem', { name });
}
async function confirm() {
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('button', { name: /^hapus$/i }));
}

describe('Scene tab — scene list (chapters)', () => {
  it('lists scenes with number, title, location, progress, status dot and duration; first is selected', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'done', 'pending'], ['done', 'pending', 'pending', 'pending']) });
    const list = await open(api);
    const items = within(list).getAllByRole('listitem');
    expect(items.map(li => li.getAttribute('aria-label'))).toEqual(['Scene 1 · Menunggu', 'Scene 2 · Pulang']);
    expect(items[0]).toHaveTextContent('Pagar rumah');
    expect(items[0]).toHaveTextContent('Keyframe 2/2');
    expect(items[0]).toHaveTextContent('Klip 1/2');
    expect(items[0]).toHaveTextContent('12 dtk');
    expect(items[1]).toHaveTextContent('Jalan desa');
    expect(items[1]).toHaveTextContent('Keyframe 1/2');
    expect(within(items[0]!).getByRole('img', { name: /status: keyframe siap/i })).toBeInTheDocument();
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(board()).toHaveAccessibleName('Scene Menunggu');
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]').length).toBe(0);
  });

  it('selects a scene by click and shows its shots', async () => {
    const api = fakeProjectApi();
    const list = await open(api);
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    expect(board()).toHaveAccessibleName('Scene Pulang');
    expect(within(grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Shot 3 · 02-jalan', 'Shot 4 · 03-peluk']);
    expect(within(list).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'true');
  });

  it('adds a scene with an inline title and selects it (empty state)', async () => {
    const api = fakeProjectApi();
    await open(api);
    await userEvent.click(screen.getByRole('button', { name: /tambah scene/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /judul scene baru/i }), 'Akhir{Enter}');
    const sent = await lastPut(api);
    expect(layout(sent)).toEqual(['menunggu:00-pembuka,01-pagar', 'pulang:02-jalan,03-peluk', 'scene-3:']);
    expect(sent.scenes![2]!.title).toBe('Akhir');
    expect(await screen.findByText('Scene ini belum punya shot')).toBeInTheDocument();
    expect(board()).toHaveAccessibleName('Scene Akhir');
    expect(screen.getByText(/seret shot dari scene lain/i)).toBeInTheDocument();
  });

  it('moves a scene up/down from its menu (non-drag path)', async () => {
    const api = fakeProjectApi();
    const list = await open(api);
    expect((await menuItem(within(list).getByRole('button', { name: 'Menu Menunggu' }), /^naik$/i))).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await menuItem(within(list).getByRole('button', { name: 'Menu Pulang' }), /^naik$/i));
    const sent = await lastPut(api);
    expect(layout(sent)).toEqual(['pulang:02-jalan,03-peluk', 'menunggu:00-pembuka,01-pagar']);
    expect(sent.shots.map(s => s.id)).toEqual(['02-jalan', '03-peluk', '00-pembuka', '01-pagar']);
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Scene 1 · Pulang', 'Scene 2 · Menunggu']));
  });
});

describe('Scene tab — scene board header', () => {
  it('edits title, summary and location; "Tanpa lokasi" removes it', async () => {
    const api = fakeProjectApi();
    await open(api);
    const title = within(board()).getByRole('textbox', { name: 'Judul scene' });
    await userEvent.clear(title);
    await waitFor(() => expect(title).toHaveValue(''));
    await userEvent.type(title, 'Menanti{Enter}');
    expect((await lastPut(api)).scenes![0]).toMatchObject({ id: 'menunggu', title: 'Menanti', summary: 'Jingga menunggu di pagar.', location: 'PAGAR' });

    const summary = within(board()).getByRole('textbox', { name: 'Ringkasan scene' });
    await userEvent.clear(summary);
    await waitFor(() => expect(summary).toHaveValue(''));
    await userEvent.type(summary, 'Sore yang panjang.');
    await userEvent.tab();
    await waitFor(() => expect(puts(api).at(-1)!.scenes![0]!.summary).toBe('Sore yang panjang.'));

    await userEvent.click(within(board()).getByRole('combobox', { name: 'Lokasi' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Tanpa lokasi' }));
    await waitFor(() => expect(puts(api).at(-1)!.scenes![0]).not.toHaveProperty('location'));
    expect(puts(api).at(-1)!.scenes![1]!.location).toBe('JALAN');

    await userEvent.click(within(board()).getByRole('combobox', { name: 'Lokasi' }));
    await userEvent.click(await screen.findByRole('option', { name: /^Jalan desa/ }));
    await waitFor(() => expect(puts(api).at(-1)!.scenes![0]!.location).toBe('JALAN'));
  });

  it('shows cast chips detected in the scene prompts', async () => {
    const api = fakeProjectApi();
    const list = await open(api);
    const cast = () => within(board()).getByRole('list', { name: /pemeran/i });
    expect(within(cast()).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Jingga']);
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    expect(within(cast()).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Jingga', 'Bima']);
  });

  it('keyframes just this scene (free)', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['pending', 'pending', 'pending', 'pending']) });
    await open(api);
    await userEvent.click(within(board()).getByRole('button', { name: /buat keyframe scene · gratis/i }));
    await waitFor(() => expect(api.calls.find(c => c.url.endsWith('/prepare'))?.body).toEqual({ scene: 'menunggu' }));
  });

  it('renders just this scene; price = not-done shots × 10', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], ['done', 'pending', 'pending', 'pending']) });
    const list = await open(api);
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    expect(within(board()).getByRole('button', { name: /render scene · ±20 kredit/i })).toBeEnabled();
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Menunggu' }));
    await userEvent.click(within(board()).getByRole('button', { name: /render scene · ±10 kredit/i }));
    await waitFor(() => expect(api.calls.find(c => c.url.endsWith('/render'))?.body).toEqual({ force: false, scene: 'menunggu' }));
  });

  it('cepat mode has no keyframe button', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { mode: 'cepat' }) });
    await open(api);
    expect(within(board()).queryByRole('button', { name: /buat keyframe scene/i })).toBeNull();
    expect(within(board()).getByRole('button', { name: /render scene · ±20 kredit/i })).toBeEnabled();
  });

  it('previews the scene: rendered clips play, others show the keyframe still', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'pending', 'pending', 'pending']) });
    api.story = { ...api.story, shots: api.story.shots.map((s, i) => (i === 0 ? { ...s, jobId: 'job0' } : s)) };
    await open(api);
    await userEvent.click(within(board()).getByRole('button', { name: /preview scene/i }));
    const player = await screen.findByRole('group', { name: 'Preview scene Menunggu' });
    expect(player.querySelector('video')).toHaveAttribute('src', `/api/stories/${ID}/shots/00-pembuka/video?v=job0`);
    expect(player.querySelector('video')).toHaveAttribute('poster', `/api/stories/${ID}/shots/00-pembuka/poster?v=job0&w=480`);
    expect(player.querySelector('div[style]')).toHaveStyle({ height: '300px' });
    await userEvent.click(within(player).getByRole('button', { name: /shot berikutnya/i }));
    expect(within(player).getByRole('img')).toHaveAttribute('src', `/api/stories/${ID}/shots/01-pagar/frame?v=m1&w=480`);
  });

  it('splits a scene from a shot menu, and deletes a scene after confirming (shots join the previous scene)', async () => {
    const api = fakeProjectApi();
    const list = await open(api);
    expect(await menuItem(within(card('01-pagar')).getByRole('button', { name: /menu shot 01-pagar/i }), /scene baru setelah shot ini/i)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await menuItem(within(card('00-pembuka')).getByRole('button', { name: /menu shot 00-pembuka/i }), /scene baru setelah shot ini/i));
    expect(layout(await lastPut(api))).toEqual(['menunggu:00-pembuka', 'scene-3:01-pagar', 'pulang:02-jalan,03-peluk']);

    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    const n = puts(api).length;
    await userEvent.click(await menuItem(within(board()).getByRole('button', { name: /aksi scene/i }), /hapus scene/i));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/2 shot pindah ke scene "Scene 2"/i);
    expect(puts(api).length).toBe(n);
    await confirm();
    await waitFor(() => expect(puts(api).length).toBe(n + 1));
    expect(layout(puts(api).at(-1)!)).toEqual(['menunggu:00-pembuka', 'scene-3:01-pagar,02-jalan,03-peluk']);
    await waitFor(() => expect(board()).toHaveAccessibleName('Scene Scene 2'));
  });

  it('durations are rounded; a scene with every clip done offers no ±0 render', async () => {
    const story = storyFor(BOARD, [], ['done', 'done', 'pending', 'pending']);
    story.shots[0]!.durationSec = 6.08; story.shots[1]!.durationSec = 6.0799999;
    const api = fakeProjectApi({ story });
    const list = await open(api);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('12 dtk');
    expect(within(list).getAllByRole('listitem')[0]).not.toHaveTextContent(/\d\.\d/);
    expect(within(board()).queryByRole('button', { name: /render scene/i })).toBeNull();
    expect(within(board()).getByText(/semua klip scene ini siap/i)).toBeInTheDocument();
    // the cast list must not shrink below its chips (it overlapped the actions on 390 px)
    expect(within(board()).getByRole('list', { name: /pemeran di scene ini/i }).className).not.toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it('a scene whose keyframes are all done offers no keyframe action (only scenes that need it do)', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['done', 'done', 'pending', 'pending']) });
    const list = await open(api);
    expect(within(board()).queryByRole('button', { name: /buat keyframe scene/i })).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    await waitFor(() => expect(within(board()).getByRole('button', { name: /buat keyframe scene/i })).toBeEnabled());
  });

  it('cannot delete the only scene', async () => {
    const one = { ...BOARD, scenes: [{ id: 'semua', title: 'Semua', shots: BOARD.shots.map(s => s.id) }] };
    const api = fakeProjectApi({ board: one, story: storyFor(one) });
    await open(api);
    expect(await menuItem(within(board()).getByRole('button', { name: /aksi scene/i }), /hapus scene/i)).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Scene tab — shot cards', () => {
  it('cards show a small keyframe thumbnail, index, status badge, narration snippet and the silent marker', async () => {
    const api = fakeProjectApi();
    await open(api);
    const first = card('00-pembuka');
    const img = within(first).getByRole('img');
    // sized for the 96 px box: 160 px webp, 320 px on 2x screens; no layout shift, no eager load
    expect(img).toHaveAttribute('src', `/api/stories/${ID}/shots/00-pembuka/frame?v=m0&w=160`);
    expect(img).toHaveAttribute('srcset', `/api/stories/${ID}/shots/00-pembuka/frame?v=m0&w=160 1x, /api/stories/${ID}/shots/00-pembuka/frame?v=m0&w=320 2x`);
    expect(img).toHaveAttribute('width', '96');
    expect(img).toHaveAttribute('height', '170');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img.parentElement).toHaveStyle({ width: '96px', height: '170px' });
    const avatar = within(within(board()).getByRole('list', { name: /pemeran di scene ini/i })).getAllByRole('listitem')[0]!.querySelector('img')!;
    expect(avatar.getAttribute('src')).toMatch(/\/cast\/JINGGA\/image\?(v=[^&]*&)?w=160$/);
    expect(avatar).toHaveAttribute('width', '20');
    expect(avatar).toHaveAttribute('decoding', 'async');
    expect(first).toHaveTextContent('Keyframe siap');
    expect(first).toHaveTextContent(/tanpa narasi/i);
    expect(card('01-pagar')).toHaveTextContent('Jingga menunggu setiap sore.');
    expect(card('01-pagar')).toHaveTextContent('02');
  });

  it('a shot with a done clip plays inline from its card (muted, sound toggle) without opening the editor', async () => {
    const story = storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'pending', 'pending', 'pending']);
    story.shots[0] = { ...story.shots[0]!, jobId: 'job0' };
    const api = fakeProjectApi({ story });
    await open(api);
    expect(within(card('01-pagar')).queryByRole('button', { name: /putar shot/i })).toBeNull();
    expect(card('00-pembuka').querySelector('video')).toBeNull();
    await userEvent.click(within(card('00-pembuka')).getByRole('button', { name: 'Putar shot 1' }));
    const video = card('00-pembuka').querySelector('video')!;
    expect(video).toHaveAttribute('src', `/api/stories/${ID}/shots/00-pembuka/video?v=job0`);
    expect(video).toHaveAttribute('autoplay');
    expect(video.muted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(within(card('00-pembuka')).getByRole('button', { name: 'Nyalakan suara shot 1' }));
    expect(video.muted).toBe(false);
    expect(within(card('00-pembuka')).getByRole('button', { name: 'Matikan suara shot 1' })).toBeInTheDocument();
    await userEvent.click(within(card('00-pembuka')).getByRole('button', { name: 'Hentikan shot 1' }));
    expect(card('00-pembuka').querySelector('video')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a done clip without a keyframe (cepat) shows its poster, not a black video', async () => {
    const story = storyFor(BOARD, ['pending', 'pending', 'pending', 'pending'], ['done', 'pending', 'pending', 'pending'], { mode: 'cepat' });
    story.shots[0] = { ...story.shots[0]!, frame: undefined, jobId: 'job0' };
    const api = fakeProjectApi({ story });
    await open(api);
    expect(card('00-pembuka').querySelector('video')).toBeNull();
    expect(card('00-pembuka').querySelector('img')).toHaveAttribute('src', `/api/stories/${ID}/shots/00-pembuka/poster?v=job0&w=160`);
  });

  it('16:9 thumbnails are landscape; undone frames show a placeholder', async () => {
    const wide = { ...BOARD, aspect: '16:9' as const };
    const api = fakeProjectApi({ board: wide, story: storyFor(wide, ['pending', 'done']) });
    await open(api);
    expect(within(card('00-pembuka')).queryByRole('img')).toBeNull();
    expect(card('00-pembuka')).toHaveTextContent('Keyframe belum dibuat');
    expect(within(card('01-pagar')).getByRole('img').parentElement).toHaveStyle({ width: '170px', height: '96px' });
  });

  it('menu: duplicate, move right/left, move to another scene, delete with confirm', async () => {
    const api = fakeProjectApi();
    await open(api);
    const menu = (id: string) => within(card(id)).getByRole('button', { name: `Menu shot ${id}` });

    await userEvent.click(await menuItem(menu('01-pagar'), /duplikat/i));
    let sent = await lastPut(api);
    expect(layout(sent)).toEqual(['menunggu:00-pembuka,01-pagar,01-pagar-2', 'pulang:02-jalan,03-peluk']);
    expect(sent.shots.find(s => s.id === '01-pagar-2')).toMatchObject({ prompt: BOARD.shots[1]!.prompt, narration: 'Jingga menunggu setiap sore.' });

    expect(await menuItem(menu('00-pembuka'), /geser kiri/i)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await menuItem(menu('00-pembuka'), /geser kanan/i));
    await waitFor(() => expect(layout(puts(api).at(-1)!)[0]).toBe('menunggu:01-pagar,00-pembuka,01-pagar-2'));
    await userEvent.click(await menuItem(menu('00-pembuka'), /geser kiri/i));
    await waitFor(() => expect(layout(puts(api).at(-1)!)[0]).toBe('menunggu:00-pembuka,01-pagar,01-pagar-2'));

    await userEvent.click(menu('01-pagar-2'));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /pindah ke scene/i }));
    const sub = await waitFor(() => { const m = screen.getAllByRole('menu'); expect(m.length).toBe(2); return m[1]!; });
    expect(within(sub).queryByRole('menuitem', { name: /menunggu/i })).toBeNull();
    await userEvent.click(within(sub).getByRole('menuitem', { name: /2\. pulang/i }));
    sent = await waitFor(() => { const b = puts(api).at(-1)!; expect(layout(b)[1]).toBe('pulang:02-jalan,03-peluk,01-pagar-2'); return b; });
    expect(sent.shots.map(s => s.id)).toEqual(['00-pembuka', '01-pagar', '02-jalan', '03-peluk', '01-pagar-2']);

    const n = puts(api).length;
    await userEvent.click(await menuItem(menu('00-pembuka'), /^hapus$/i));
    expect(puts(api).length).toBe(n);
    await confirm();
    await waitFor(() => expect(layout(puts(api).at(-1)!)).toEqual(['menunggu:01-pagar', 'pulang:02-jalan,03-peluk,01-pagar-2']));
    expect(puts(api).at(-1)!.shots.some(s => s.id === '00-pembuka')).toBe(false);
  });

  it('+ Shot appends a shot to the scene and opens it in the sheet; the card opens the sheet too', async () => {
    const api = fakeProjectApi();
    await open(api);
    await userEvent.click(within(board()).getByRole('button', { name: /tambah shot/i }));
    const sent = await lastPut(api);
    expect(layout(sent)).toEqual(['menunggu:00-pembuka,01-pagar,shot-5', 'pulang:02-jalan,03-peluk']);
    expect(await screen.findByRole('dialog', { name: /shot 3 · shot-5/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(card('01-pagar')).getByRole('button', { name: /edit shot 2/i }));
    const sheet = await screen.findByRole('dialog', { name: /shot 2 · 01-pagar/i });
    expect(await within(sheet).findByRole('combobox', { name: 'Framing' })).toHaveTextContent('Medium');
  });

  it('empty scene: message, + Shot and the drag hint', async () => {
    const b = { ...BOARD, scenes: [...BOARD.scenes!, { id: 'kosong', title: 'Kosong', shots: [] }] };
    const api = fakeProjectApi({ board: b, story: storyFor(b) });
    const list = await open(api);
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Kosong' }));
    expect(within(board()).getByText('Scene ini belum punya shot')).toBeInTheDocument();
    expect(within(board()).getByText(/atau seret shot dari scene lain/i)).toBeInTheDocument();
    await userEvent.click(within(board()).getByRole('button', { name: /tambah shot/i }));
    expect(layout(await lastPut(api))[2]).toBe('kosong:shot-5');
  });

  it('is read-only while the story is working, with the reason', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, ['queued', 'pending', 'pending', 'pending'], [], { status: 'rendering' }) });
    const list = await open(api);
    expect(screen.getByText(/sedang dirender — scene dan shot dikunci sampai selesai/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tambah scene/i })).toBeDisabled();
    expect(within(board()).getByRole('button', { name: /tambah shot/i })).toBeDisabled();
    expect(within(board()).getByRole('textbox', { name: 'Judul scene' })).toBeDisabled();
    expect(within(board()).getByRole('button', { name: /render scene/i })).toBeDisabled();
    expect(within(board()).getByRole('button', { name: /buat keyframe scene/i })).toBeDisabled();
    expect(within(card('00-pembuka')).getByRole('button', { name: 'Menu shot 00-pembuka' })).toBeDisabled();
    expect(within(list).getByRole('button', { name: 'Menu Pulang' })).toBeDisabled();
    // Selecting and previewing still work.
    await userEvent.click(within(list).getByRole('button', { name: 'Pilih Pulang' }));
    expect(board()).toHaveAccessibleName('Scene Pulang');
  });

  it('a refused save rolls the board back and shows the reason', async () => {
    const api = fakeProjectApi({ fail: { put: { status: 400, message: 'narration is empty' } } });
    await open(api);
    await userEvent.click(await menuItem(within(card('00-pembuka')).getByRole('button', { name: 'Menu shot 00-pembuka' }), /geser kanan/i));
    expect(await screen.findByRole('alert')).toHaveTextContent(/tidak tersimpan/i);
    expect(within(grid()).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Shot 1 · 00-pembuka', 'Shot 2 · 01-pagar']);
  });
});

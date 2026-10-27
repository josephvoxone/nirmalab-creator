import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import type { Board } from './model.js';
import { BIBLE, bibleBoard, fakeProjectApi, mountProject, storyFor } from './testkit.js';

type Api = ReturnType<typeof fakeProjectApi>;
const GOAL = 'mis. Laras menyembunyikan Kapas dari pembeli';

async function open(api: Api) {
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
  return screen.findByRole('list', { name: /daftar scene/i });
}
const puts = (api: Api) => api.calls.filter(c => c.method === 'PUT').map(c => c.body!.storyboard as Board & { bible?: typeof BIBLE });
const lastPut = async (api: Api) => { await waitFor(() => expect(puts(api).length).toBeGreaterThan(0)); return puts(api).at(-1)!; };
const layout = (b: Board) => b.scenes!.map(s => `${s.id}:${s.shots.join(',')}`);
const grid = () => within(screen.getByRole('region', { name: /^Scene / })).getByRole('list', { name: /shot di scene/i });
const card = (id: string) => within(grid()).getByRole('listitem', { name: new RegExp(`· ${id}$`) });

function bibleApi() {
  const board = bibleBoard();
  return fakeProjectApi({ board, story: storyFor(board) });
}

/** Fill the new-scene form: title, the required goal, a location. */
async function fill(dialog: HTMLElement, title: string, goal: string, location?: RegExp) {
  const titleBox = within(dialog).getByRole('textbox', { name: 'Judul scene' });
  await userEvent.clear(titleBox);
  await userEvent.type(titleBox, title);
  const create = within(dialog).getByRole('button', { name: /buat scene/i });
  expect(create).toBeDisabled();
  await userEvent.type(within(dialog).getByRole('textbox', { name: /tujuan/i }), goal);
  if (location) {
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Lokasi' }));
    await userEvent.click(await screen.findByRole('option', { name: location }));
  }
  expect(create).toBeEnabled();
  await userEvent.click(create);
}

describe('Scene baru on bible boards: the scene gets its goal card in the same save', () => {
  it('"Tambah scene" asks for a title, a required goal and a location from the bible, then saves both sides', async () => {
    const api = bibleApi();
    await open(api);
    await userEvent.click(screen.getByRole('button', { name: /tambah scene/i }));
    const dialog = await screen.findByRole('dialog', { name: /scene baru/i });
    const goal = within(dialog).getByRole('textbox', { name: /tujuan/i });
    expect(goal).toHaveAttribute('placeholder', GOAL);
    expect(goal).toBeRequired();
    expect(within(dialog).getByRole('combobox', { name: 'Lokasi' })).toHaveTextContent('Pilih…');
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
    await fill(dialog, 'Hujan', 'Jingga berteduh sendirian', /^Jalan desa/);
    const sent = await lastPut(api);
    expect(layout(sent)).toEqual(['menunggu:00-pembuka,01-pagar', 'pulang:02-jalan,03-peluk', 'scene-3:']);
    expect(sent.scenes![2]).toMatchObject({ id: 'scene-3', title: 'Hujan', location: 'JALAN' });
    expect(sent.bible!.scenes).toEqual([...BIBLE.scenes, { id: 'scene-3', title: 'Hujan', goal: 'Jingga berteduh sendirian', location: 'JALAN' }]);
    expect(api.board.scenes!.map(s => s.title)).toContain('Hujan');
  });

  it('"Scene baru setelah shot ini" opens the same form instead of saving blind; the location is optional', async () => {
    const api = bibleApi();
    await open(api);
    await userEvent.click(within(card('00-pembuka')).getByRole('button', { name: /menu shot 00-pembuka/i }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /scene baru setelah shot ini/i }));
    const dialog = await screen.findByRole('dialog', { name: /scene baru/i });
    expect(puts(api)).toHaveLength(0);
    await fill(dialog, 'Penantian', 'Jingga mulai gelisah');
    const sent = await lastPut(api);
    expect(layout(sent)).toEqual(['menunggu:00-pembuka', 'scene-3:01-pagar', 'pulang:02-jalan,03-peluk']);
    expect(sent.bible!.scenes.at(-1)).toEqual({ id: 'scene-3', title: 'Penantian', goal: 'Jingga mulai gelisah' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /scene baru/i })).toBeNull());
  });

  it('Batal closes the form without saving', async () => {
    const api = bibleApi();
    await open(api);
    await userEvent.click(screen.getByRole('button', { name: /tambah scene/i }));
    const dialog = await screen.findByRole('dialog', { name: /scene baru/i });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /tujuan/i }), 'apa saja');
    await userEvent.click(within(dialog).getByRole('button', { name: /^batal$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /scene baru/i })).toBeNull());
    expect(puts(api)).toHaveLength(0);
  });

  it('legacy boards keep the inline title field and the blind split (no goal, no bible)', async () => {
    const api = fakeProjectApi();
    await open(api);
    await userEvent.click(screen.getByRole('button', { name: /tambah scene/i }));
    expect(screen.queryByRole('dialog', { name: /scene baru/i })).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: /judul scene baru/i }), 'Akhir{Enter}');
    const sent = await lastPut(api);
    expect(sent.scenes!.at(-1)).toMatchObject({ title: 'Akhir', shots: [] });
    expect(sent).not.toHaveProperty('bible');
    await userEvent.click(screen.getByRole('button', { name: 'Pilih Menunggu' }));
    await userEvent.click(within(card('00-pembuka')).getByRole('button', { name: /menu shot 00-pembuka/i }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /scene baru setelah shot ini/i }));
    await waitFor(() => expect(puts(api)).toHaveLength(2));
    expect(screen.queryByRole('dialog', { name: /scene baru/i })).toBeNull();
  });
});

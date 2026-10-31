import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor, type Call } from './testkit.js';
import { withEdit } from './TimelineModel.js';

const open = (api: ReturnType<typeof fakeProjectApi>) => mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=timeline` });
const allDone = () => storyFor(BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']);
const lastBoard = (calls: Call[]) => calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as { edit?: { fadeIn?: number; beatCuts?: unknown; subtitles?: boolean } } | undefined;
/** A Switch (a role=switch element, not a form control) is disabled when it says so. */
const off = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
const fade = () => screen.getByRole('radiogroup', { name: 'Fade awal' });
const withBoard = (edit: Record<string, unknown>) => ({ ...BOARD, edit });

describe('E5 Timeline: Potong ritme', () => {
  it('is off by default, saves beatCuts {} when switched on and removes it when switched off', async () => {
    const api = fakeProjectApi({ story: allDone() });
    open(api);
    const sw = await screen.findByRole('switch', { name: 'Potong ritme' });
    expect(sw).not.toBeChecked();
    expect(screen.queryByRole('radiogroup', { name: 'Kekuatan potong ritme' })).toBeNull();     // the strength only matters once it is on
    await userEvent.click(sw);
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ beatCuts: {} }));
    expect(await screen.findByRole('switch', { name: 'Potong ritme' })).toBeChecked();
    await userEvent.click(screen.getByRole('switch', { name: 'Potong ritme' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toBeUndefined());
    expect(lastBoard(api.calls)).not.toHaveProperty('edit');
  });

  it('a board that has it on shows it on, with its strength; the presets save the zoom', async () => {
    const board = withBoard({ beatCuts: { zoom: 1.22 } });
    const api = fakeProjectApi({ board, story: storyFor(board as typeof BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']) });
    open(api);
    expect(await screen.findByRole('switch', { name: 'Potong ritme' })).toBeChecked();
    const strength = screen.getByRole('radiogroup', { name: 'Kekuatan potong ritme' });
    expect(within(strength).getByRole('radio', { name: 'Kuat' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(strength).getByRole('radio', { name: 'Halus' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ beatCuts: { zoom: 1.08 } }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Kekuatan potong ritme' })).getByRole('radio', { name: 'Sedang' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ beatCuts: {} }));
  });

  it('an old board (beatCuts: false or absent) shows it off', async () => {
    const board = withBoard({ beatCuts: false, subtitles: true });
    open(fakeProjectApi({ board, story: storyFor(board as typeof BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']) }));
    expect(await screen.findByRole('switch', { name: 'Potong ritme' })).not.toBeChecked();
  });
});

describe('E5 Timeline: Fade awal', () => {
  it('shows Normal for a board without the field and saves the other presets (Normal removes the field)', async () => {
    const api = fakeProjectApi({ story: allDone() });
    open(api);
    await screen.findByRole('radiogroup', { name: 'Fade awal' });
    expect(within(fade()).getAllByRole('radio').map(r => r.textContent)).toEqual(['Tanpa', 'Cepat', 'Normal', 'Lambat']);
    expect(within(fade()).getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Cepat' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ fadeIn: 0.25 }));
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Tanpa' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ fadeIn: 0 }));
    expect(within(fade()).getByRole('radio', { name: 'Tanpa' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Lambat' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ fadeIn: 1.2 }));
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Normal' }));
    await waitFor(() => expect(lastBoard(api.calls)).not.toHaveProperty('edit'));
  });

  it('every preset says in plain words what it does', async () => {
    open(fakeProjectApi({ story: allDone() }));
    await screen.findByRole('radiogroup', { name: 'Fade awal' });
    const hints = Object.fromEntries(within(fade()).getAllByRole('radio').map(r => [r.textContent, r.getAttribute('title')]));
    expect(hints.Tanpa).toMatch(/langsung/i);
    expect(hints.Cepat).toMatch(/0,25/);
    expect(hints.Normal).toMatch(/0,8/);
    expect(hints.Lambat).toMatch(/1,2/);
  });

  it('keeps the other edits when it changes (subtitles stay on)', async () => {
    const board = withBoard({ subtitles: true, beatCuts: {} });
    const api = fakeProjectApi({ board, story: storyFor(board as typeof BOARD, ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']) });
    open(api);
    await screen.findByRole('radiogroup', { name: 'Fade awal' });
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Cepat' }));
    await waitFor(() => expect(lastBoard(api.calls)?.edit).toEqual({ subtitles: true, beatCuts: {}, fadeIn: 0.25 }));
  });
});

describe('E5 Timeline: the three states', () => {
  it('loading: while a save is on its way the controls are disabled, and come back after', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(r => { release = r; });
    const api = fakeProjectApi({ story: allDone(), extra: async call => { if (call.method === 'PUT') await gate; return undefined; } });
    open(api);
    const sw = await screen.findByRole('switch', { name: 'Potong ritme' });
    await userEvent.click(sw);
    await waitFor(() => expect(off(screen.getByRole('switch', { name: 'Potong ritme' }))).toBe(true));
    for (const r of within(fade()).getAllByRole('radio')) expect(r).toBeDisabled();
    release!();
    await waitFor(() => expect(off(screen.getByRole('switch', { name: 'Potong ritme' }))).toBe(false));
    for (const r of within(fade()).getAllByRole('radio')) expect(r).toBeEnabled();
  });

  it('error: a refused save leaves the controls showing what is stored and says so in plain Indonesian', async () => {
    const api = fakeProjectApi({ story: allDone(), fail: { put: { status: 500, message: 'Gagal menyimpan perubahan. Coba lagi.' } } });
    open(api);
    await userEvent.click(await screen.findByRole('switch', { name: 'Potong ritme' }));
    await userEvent.click(within(fade()).getByRole('radio', { name: 'Cepat' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).toMatch(/gagal menyimpan/i);
    await waitFor(() => expect(off(screen.getByRole('switch', { name: 'Potong ritme' }))).toBe(false));
    expect(screen.getByRole('switch', { name: 'Potong ritme' })).not.toBeChecked();
    expect(within(fade()).getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
  });

  it('empty: with no shots there is nothing to cut or fade, so neither control is shown', async () => {
    const empty = { ...BOARD, scenes: [{ id: 'scene-1', title: 'Scene 1', shots: [] }], shots: [] };
    open(fakeProjectApi({ board: empty, story: storyFor(empty) }));
    expect(await screen.findByText(/belum ada shot di timeline/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Potong ritme' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Fade awal' })).toBeNull();
  });

  it('no native select, checkbox, radio, range or date control in the toolbar (Segmented and Switch only)', async () => {
    open(fakeProjectApi({ story: allDone() }));
    const toolbar = (await screen.findByRole('switch', { name: 'Potong ritme' })).closest('div.flex-wrap')!;
    expect(toolbar.querySelectorAll('select, input:not([aria-hidden=true])[type=checkbox], input[type=radio], input[type=range], input[type=date], input[type=time], input[type=number]')).toHaveLength(0);
  });
});

describe('E5 model', () => {
  it('withEdit keeps beatCuts and fadeIn, and drops them when set to undefined', () => {
    const b = withEdit(withEdit(BOARD, { beatCuts: {} }), { fadeIn: 0 });
    expect((b.edit as Record<string, unknown>)).toEqual({ beatCuts: {}, fadeIn: 0 });
    expect(withEdit(withEdit(b, { beatCuts: undefined }), { fadeIn: undefined })).not.toHaveProperty('edit');
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../stories/testCatalog.js';
import type { Board } from './model.js';
import { ShotSheet } from './ShotSheet.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import { ProjectProvider, useProjectState } from './useProject.js';

type Api = ReturnType<typeof fakeProjectApi>;

function Harness(props: { shotId: string; onClose: () => void }) {
  const { id = '' } = useParams();
  const p = useProjectState(id, 0);
  if (!p.board || !p.story) return <p>memuat</p>;
  return <ProjectProvider value={p}><ShotSheet shotId={props.shotId} catalog={CATALOG} onClose={props.onClose} /></ProjectProvider>;
}

async function open(api: Api, shotId = '01-pagar', onClose = vi.fn()) {
  mountProject(<Harness shotId={shotId} onClose={onClose} />, api.fetchImpl);
  return screen.findByRole('dialog', { name: new RegExp(`· ${shotId}$`) });
}
const puts = (api: Api) => api.calls.filter(c => c.method === 'PUT').map(c => c.body!.storyboard as Board);
const lastPut = async (api: Api) => { await waitFor(() => expect(puts(api).length).toBeGreaterThan(0)); return puts(api).at(-1)!; };
const posted = (api: Api, end: string) => api.calls.find(c => c.method === 'POST' && c.url.endsWith(end));

describe('ShotSheet', () => {
  it('titles the sheet with the shot number in its scene and shows a bounded keyframe preview with fullscreen', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api, '03-peluk');
    expect(sheet).toHaveAccessibleName('Shot 2 · 03-peluk');
    expect(sheet).toHaveTextContent('Pulang');
    const img = within(sheet).getByRole('img', { name: /keyframe 03-peluk/i });
    expect(img).toHaveAttribute('src', `/api/stories/${ID}/shots/03-peluk/frame?v=m3`);
    expect(img).toHaveStyle({ maxHeight: '300px' });
    expect(within(sheet).getByRole('button', { name: /layar penuh/i })).toBeInTheDocument();
    expect(within(within(sheet).getByRole('list', { name: /pemeran/i })).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Jingga', 'Bima']);
  });

  it('plays the rendered clip (ClipPreview) when the clip is done', async () => {
    const story = storyFor(BOARD, [], ['pending', 'done']);
    story.shots[1] = { ...story.shots[1]!, jobId: 'job1' };
    const api = fakeProjectApi({ story });
    const sheet = await open(api);
    const video = within(sheet).getByLabelText('Klip 01-pagar');
    expect(video).toHaveAttribute('src', `/api/stories/${ID}/shots/01-pagar/video?v=job1`);
    expect(video).toHaveStyle({ maxHeight: '300px' });
    expect(sheet).toHaveTextContent('Klip siap');
  });

  it('counts narration words live (/12, red over the limit) and saves only a changed, valid shot', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    const save = within(sheet).getByRole('button', { name: /^simpan$/i });
    expect(save).toBeDisabled();
    const count = within(sheet).getByText('4/12');
    expect(count).not.toHaveClass('text-destructive');
    const narration = within(sheet).getByRole('textbox', { name: 'Narasi' });
    await userEvent.type(narration, ' satu dua tiga empat lima enam tujuh delapan sembilan');
    expect(within(sheet).getByText('13/12')).toHaveClass('text-destructive');
    expect(narration).toHaveAttribute('aria-invalid', 'true');
    expect(save).toBeDisabled();
    await userEvent.clear(narration);
    await userEvent.type(narration, 'Jingga menunggu Bima setiap sore.');
    expect(within(sheet).getByText('5/12')).toBeInTheDocument();
    await userEvent.click(save);
    const sent = await lastPut(api);
    expect(sent.shots[1]).toEqual({ ...BOARD.shots[1], narration: 'Jingga menunggu Bima setiap sore.' });
    expect(sent.shots.filter((_, i) => i !== 1)).toEqual(BOARD.shots.filter((_, i) => i !== 1));
    expect(sent.scenes).toEqual(BOARD.scenes);
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('empty narration needs the silent switch; silent saves silent: true', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    const narration = within(sheet).getByRole('textbox', { name: 'Narasi' });
    await userEvent.clear(narration);
    expect(within(sheet).getByRole('button', { name: /^simpan$/i })).toBeDisabled();
    const silent = within(sheet).getByRole('switch', { name: 'Tanpa narasi (intro/outro)' });
    expect(silent).not.toBeChecked();
    await userEvent.click(silent);
    expect(silent).toBeChecked();
    expect(narration).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    const shot = (await lastPut(api)).shots[1]!;
    expect(shot).toMatchObject({ id: '01-pagar', silent: true, prompt: BOARD.shots[1]!.prompt });
    expect(shot).not.toHaveProperty('narration');
  });

  it('framing and camera move rewrite the first sentence of the prompt', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    const prompt = within(sheet).getByRole('textbox', { name: /prompt/i });
    expect(within(sheet).getByRole('combobox', { name: 'Framing' })).toHaveTextContent('Medium');
    await userEvent.click(within(sheet).getByRole('combobox', { name: 'Framing' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Close-up' }));
    expect(prompt).toHaveValue('Close-up, the camera stays still. JINGGA sits by the gate.');
    await userEvent.click(within(sheet).getByRole('combobox', { name: 'Gerakan kamera' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Push in' }));
    expect(prompt).toHaveValue('Close-up, the camera pushes in slowly. JINGGA sits by the gate.');
    await userEvent.type(prompt, ' BIMA waves.');
    expect(within(within(sheet).getByRole('list', { name: /pemeran/i })).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Jingga', 'Bima']);
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    expect((await lastPut(api)).shots[1]!.prompt).toBe('Close-up, the camera pushes in slowly. JINGGA sits by the gate. BIMA waves.');
  });

  it('redraws the keyframe for free with the edited prompt', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    const prompt = within(sheet).getByRole('textbox', { name: /prompt/i });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Wide shot, the camera stays still. JINGGA naps.');
    await userEvent.click(within(sheet).getByRole('button', { name: /gambar ulang keyframe · gratis/i }));
    await waitFor(() => expect(posted(api, '/shots/01-pagar/frame')?.body).toEqual({ prompt: 'Wide shot, the camera stays still. JINGGA naps.' }));
  });

  it('redraws without a prompt when unchanged; no redraw in cepat mode', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    await userEvent.click(within(sheet).getByRole('button', { name: /gambar ulang keyframe/i }));
    await waitFor(() => expect(posted(api, '/shots/01-pagar/frame')?.body).toEqual({}));
  });

  it('cepat mode: no keyframe redraw', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { mode: 'cepat' }) });
    const sheet = await open(api);
    expect(within(sheet).queryByRole('button', { name: /gambar ulang keyframe/i })).toBeNull();
  });

  it('renders just this shot (±10 kredit); disabled while there are unsaved edits', async () => {
    const api = fakeProjectApi();
    const sheet = await open(api);
    const render = within(sheet).getByRole('button', { name: /render shot ini · ±10 kredit/i });
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Narasi' }), ' lagi');
    expect(render).toBeDisabled();
    expect(sheet).toHaveTextContent(/simpan dulu/i);
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(render).toBeEnabled());
    await userEvent.click(render);
    await waitFor(() => expect(posted(api, '/render')?.body).toEqual({ force: false, shot: '01-pagar' }));
  });

  it('deletes the shot after confirming and closes', async () => {
    const api = fakeProjectApi();
    const onClose = vi.fn();
    const sheet = await open(api, '01-pagar', onClose);
    await userEvent.click(within(sheet).getByRole('button', { name: /^hapus$/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(puts(api)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: /^hapus$/i }));
    const sent = await lastPut(api);
    expect(sent.shots.map(s => s.id)).toEqual(['00-pembuka', '02-jalan', '03-peluk']);
    expect(sent.scenes![0]!.shots).toEqual(['00-pembuka']);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the take status and errors', async () => {
    const story = storyFor(BOARD);
    story.shots[1] = { ...story.shots[1]!, frame: { status: 'failed', attempts: 3, error: 'Flow menolak prompt' } };
    story.shots[2] = { ...story.shots[2]!, status: 'queued', lastError: 'klip terlalu pendek' };
    const api = fakeProjectApi({ story });
    const sheet = await open(api);
    expect(sheet).toHaveTextContent('Keyframe gagal');
    expect(sheet).toHaveTextContent('Flow menolak prompt');
    expect(within(sheet).queryByRole('img', { name: /keyframe/i })).toBeNull();
  });

  it('shows a retake reason while a take is re-queued', async () => {
    const story = storyFor(BOARD);
    story.shots[1] = { ...story.shots[1]!, status: 'queued', lastError: 'klip terlalu pendek' };
    const api = fakeProjectApi({ story: { ...story, status: 'rendering' } });
    const sheet = await open(api);
    expect(sheet).toHaveTextContent(/take ulang: klip terlalu pendek/i);
  });

  it('is read-only while the story is working, with a one-line reason', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { status: 'casting' }) });
    const sheet = await open(api);
    expect(sheet).toHaveTextContent(/sedang membuat karakter — shot dikunci sampai selesai/i);
    expect(within(sheet).getByRole('textbox', { name: 'Narasi' })).toBeDisabled();
    expect(within(sheet).getByRole('textbox', { name: /prompt/i })).toBeDisabled();
    expect(within(sheet).getByRole('switch', { name: /tanpa narasi/i })).toHaveAttribute('aria-disabled', 'true');
    for (const name of [/^simpan$/i, /gambar ulang/i, /render shot ini/i, /^hapus$/i]) expect(within(sheet).getByRole('button', { name })).toBeDisabled();
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]:not([aria-hidden=true])').length).toBe(0);
  });
});

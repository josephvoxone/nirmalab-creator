import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../stories/testCatalog.js';
import type { Board } from './model.js';
import { ShotSheet } from './ShotSheet.js';
import { BOARD, bibleBoard, compileRoute, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
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
    expect(img).toHaveAttribute('src', `/api/stories/${ID}/shots/03-peluk/frame?v=m3&w=480`);
    expect(img).toHaveAttribute('decoding', 'async');
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
    expect(video).toHaveAttribute('poster', `/api/stories/${ID}/shots/01-pagar/poster?v=job1&w=480`);
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

describe('ShotSheet — bible boards (intent)', () => {
  const compiles = (api: Api) => api.calls.filter(c => c.url.endsWith('/compile-shot'));
  const bibleApi = () => fakeProjectApi({ board: bibleBoard(), extra: compileRoute });

  it('edits the intent fields and shows the compiled prompt read-only instead of a prompt textarea', async () => {
    const api = bibleApi();
    const sheet = await open(api);
    for (const name of ['Subjek', 'Aksi']) expect(within(sheet).getByRole('combobox', { name })).toBeInTheDocument();
    for (const name of ['Keadaan awal', 'Keadaan akhir', 'Emosi', 'Narasi']) expect(within(sheet).getByRole('textbox', { name })).toBeInTheDocument();
    expect(within(sheet).getByRole('combobox', { name: 'Subjek' })).toHaveValue('JINGGA');
    expect(within(sheet).getByRole('combobox', { name: 'Aksi' })).toHaveValue('sits by the gate');
    expect(within(sheet).getByRole('combobox', { name: 'Framing' })).toHaveTextContent('Medium');
    expect(within(sheet).getByRole('combobox', { name: 'Gerak kamera' })).toHaveTextContent('Static');
    expect(within(sheet).getByText('4/12')).toBeInTheDocument();
    expect(within(sheet).queryByRole('textbox', { name: /prompt \(english\)/i })).toBeNull();
    expect(within(sheet).getByRole('radiogroup', { name: 'Suara' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: /prompt yang dikirim/i }));
    const sent = await within(sheet).findByRole('region', { name: 'Prompt yang dikirim' });
    expect(await within(sent).findByText('medium · JINGGA sits by the gate, tail curled around the paws → ears up toward the road.')).toBeInTheDocument();
    expect(within(sent).queryByRole('textbox')).toBeNull();
    expect(compiles(api)[0]!.body!.shot).toMatchObject({ id: '01-pagar', intent: { subject: 'JINGGA', action: 'sits by the gate' } });
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });

  it('debounces the preview (one compile after a burst of typing) and lists issues without blocking the save', async () => {
    const api = bibleApi();
    const sheet = await open(api);
    await waitFor(() => expect(compiles(api)).toHaveLength(1));
    const action = within(sheet).getByRole('combobox', { name: 'Aksi' });
    // Fake clock (setTimeout only): the burst, the 400 ms quiet period and the 600 ms after it take no
    // real time. Keystrokes go through fireEvent: user-event waits on a real-looking setTimeout(0) between
    // actions, which a faked setTimeout never fires.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const tail of [' q', ' qu', ' quiet', ' quietly']) {
        act(() => { fireEvent.change(action, { target: { value: `sits by the gate${tail}` } }); });
        await act(async () => { vi.advanceTimersByTime(100); });
      }
      expect(compiles(api)).toHaveLength(1);
      // 100 ms since the last keystroke: still quiet, 300 ms to go.
      await act(async () => { vi.advanceTimersByTime(299); });
      expect(compiles(api)).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(compiles(api)).toHaveLength(2);
      expect(compiles(api)[1]!.body!.shot).toMatchObject({ intent: { action: 'sits by the gate quietly' } });
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(compiles(api)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }

    await userEvent.clear(action);
    const issues = await within(sheet).findByRole('list', { name: 'Masalah prompt' });
    expect(issues).toHaveTextContent('mandatory slot action is empty');
    const save = within(sheet).getByRole('button', { name: /^simpan$/i });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    const shot = (await lastPut(api)).shots[1]!;
    expect(shot.intent).toMatchObject({ subject: 'JINGGA', action: '', startState: 'tail curled around the paws' });
  });

  it('saves intent edits (mention in Subjek, framing, emotion, Tanpa suara) and leaves the prompt to the server', async () => {
    const api = bibleApi();
    const sheet = await open(api);
    const subject = within(sheet).getByRole('combobox', { name: 'Subjek' });
    await userEvent.clear(subject);
    await userEvent.type(subject, '@Bi');
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: /bima/i })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(subject).toHaveValue('BIMA ');
    expect(screen.getByRole('dialog', { name: /01-pagar$/ })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('combobox', { name: 'Framing' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Close-up' }));
    const emotion = within(sheet).getByRole('textbox', { name: 'Emosi' });
    await userEvent.clear(emotion);
    await userEvent.type(emotion, 'lega');
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Tanpa suara' }));
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    const shot = (await lastPut(api)).shots[1]!;
    expect(shot.intent).toEqual({ subject: 'BIMA', action: 'sits by the gate', startState: 'tail curled around the paws', endState: 'ears up toward the road', emotion: 'lega', framing: 'close-up', move: 'static' });
    expect(shot.silent).toBe(true);
    expect(shot.prompt).toBe(BOARD.shots[1]!.prompt);
  });

  it('a prose shot on a bible board keeps its prompt and offers "Ubah ke niat"; all four slots are needed to save', async () => {
    const api = bibleApi();
    const sheet = await open(api, '00-pembuka');
    expect(within(sheet).getByRole('textbox', { name: /prompt \(english\)/i })).toHaveValue(BOARD.shots[0]!.prompt);
    expect(within(sheet).queryByRole('combobox', { name: 'Subjek' })).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: /ubah ke niat/i }));
    expect(within(sheet).queryByRole('textbox', { name: /prompt \(english\)/i })).toBeNull();
    const subject = within(sheet).getByRole('combobox', { name: 'Subjek' });
    expect(subject).toHaveValue('');
    expect(within(sheet).getByRole('combobox', { name: 'Framing' })).toHaveTextContent('Wide');
    const save = within(sheet).getByRole('button', { name: /^simpan$/i });
    expect(save).toBeDisabled();
    expect(sheet).toHaveTextContent(/wajib diisi: subjek, aksi, keadaan awal dan akhir/i);
    await userEvent.type(subject, 'a street');
    await userEvent.type(within(sheet).getByRole('combobox', { name: 'Aksi' }), 'fades');
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Keadaan awal' }), 'sun up');
    expect(save).toBeDisabled();
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Keadaan akhir' }), 'lamps lit');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    const shot = (await lastPut(api)).shots[0]!;
    expect(shot.intent).toEqual({ subject: 'a street', action: 'fades', startState: 'sun up', endState: 'lamps lit', framing: 'wide', move: 'static' });
    expect(shot.silent).toBe(true);
  });

  it('legacy boards keep the prompt textarea and have no "Ubah ke niat"', async () => {
    const api = fakeProjectApi({ extra: compileRoute });
    const sheet = await open(api);
    expect(within(sheet).getByRole('textbox', { name: /prompt \(english\)/i })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /ubah ke niat/i })).toBeNull();
    expect(within(sheet).queryByRole('combobox', { name: 'Subjek' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: /prompt yang dikirim/i })).toBeNull();
    expect(compiles(api)).toHaveLength(0);
  });
});

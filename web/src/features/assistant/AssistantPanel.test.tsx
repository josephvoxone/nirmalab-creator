import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bibleBoard, BOARD, storyFor } from '../project/testkit.js';
import type { Board } from '../project/model.js';
import type { Story } from '../stories/storiesClient.js';
import { AssistantPanel } from './AssistantPanel.js';
import { PLACEHOLDER } from './Composer.js';
import { sseParser } from './sse.js';
import { ev, fakeAssistantApi, mountWith, SID, turn } from './testkit.js';

type Api = ReturnType<typeof fakeAssistantApi>;

function mount(api: Api, opts: { board?: Board; story?: Story; onChanged?: () => void } = {}) {
  const board = opts.board ?? bibleBoard();
  const story = opts.story ?? { ...storyFor(board), id: SID, rev: 2 };
  const onChanged = opts.onChanged ?? vi.fn();
  const utils = mountWith(<AssistantPanel story={story} board={board} onChanged={onChanged} />, api.fetchImpl);
  return { ...utils, onChanged };
}

const composer = () => screen.getByRole('combobox', { name: 'Pesan untuk asisten' });
const fileInput = () => document.querySelector('input[type=file]') as HTMLInputElement;
const png = (name = 'ref.png', size = 2048) => { const f = new File(['x'], name, { type: 'image/png' }); Object.defineProperty(f, 'size', { value: size }); return f; };

async function ready() {
  await screen.findByRole('combobox', { name: 'Pesan untuk asisten' });
}

async function sendText(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(composer(), text);
  await user.keyboard('{Enter}');
}

afterEach(() => vi.restoreAllMocks());

describe('sse parser', () => {
  it('joins events split across chunks and skips ": ping" comment lines', () => {
    const p = sseParser();
    expect(p.push(': ping\n\nevent: delta\nda')).toEqual([]);
    expect(p.push('ta: {"text":"Ha"}\n\n: ping\n\nevent: done\r\ndata: {"rev":3}\r\n\r\n')).toEqual([
      { event: 'delta', data: { text: 'Ha' } }, { event: 'done', data: { rev: 3 } }
    ]);
  });
});

describe('AssistantPanel', () => {
  it('loads the history with a message-shaped skeleton, then shows the messages', async () => {
    const api = fakeAssistantApi({
      holdHistory: true,
      turns: [turn({ id: 't1', role: 'user', text: 'Halo asisten' }), turn({ id: 't2', role: 'assistant', text: 'Halo juga.' })]
    });
    mount(api);
    expect(screen.getByRole('status', { name: 'Memuat percakapan' })).toBeInTheDocument();
    api.releaseHistory();
    expect(await screen.findByText('Halo asisten')).toBeInTheDocument();
    expect(screen.getByText('Halo juga.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Memuat percakapan' })).toBeNull();
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
  });

  it('a failed history load says why and retries', async () => {
    const api = fakeAssistantApi({ historyFail: true });
    mount(api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Percakapan gagal dimuat');
    expect(alert).toHaveTextContent('Server sedang bermasalah');
    await userEvent.setup().click(within(alert).getByRole('button', { name: /Coba lagi/ }));
    expect(api.calls.filter(c => c.method === 'GET')).toHaveLength(2);
  });

  it('shows the user bubble at once, then the step line, streamed text and a change chip; reloads the project when rev moved', async () => {
    const api = fakeAssistantApi();
    const { onChanged } = mount(api);
    await ready();
    const user = userEvent.setup();
    await sendText(user, 'Di shot 2, buat Jingga lebih lega');
    expect(screen.getByText('Di shot 2, buat Jingga lebih lega')).toBeInTheDocument();
    expect(api.posts()[0]!.body).toEqual({ message: 'Di shot 2, buat Jingga lebih lega' });
    expect(screen.getByLabelText('Asisten sedang menulis')).toBeInTheDocument();
    await waitFor(() => expect(composer()).toHaveFocus());

    const s = api.streams[0]!;
    act(() => { s.push(ev('turn', { id: 't_a1' }) + ': ping\n\n' + ev('step', { label: 'Mengubah shot 2' })); });
    expect(await screen.findByText('Mengubah shot 2…')).toBeInTheDocument();
    act(() => { s.push(ev('change', { label: 'Shot 2 diubah', undoId: 'u1' }) + ev('delta', { text: 'Shot 2 sekarang ' })); });
    expect(await screen.findByText('Shot 2 sekarang')).toBeInTheDocument();
    act(() => { s.push(': ping\n\n' + ev('delta', { text: 'medium wide.' })); });
    expect(await screen.findByText('Shot 2 sekarang medium wide.')).toBeInTheDocument();
    expect(screen.getByText('Shot 2 diubah')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batalkan: Shot 2 diubah' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    act(() => { s.push(ev('done', { rev: 3 })); s.end(); });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Mengubah shot 2…')).toBeNull());
    // The history is refreshed in the background after the turn.
    await waitFor(() => expect(api.calls.filter(c => c.method === 'GET')).toHaveLength(2));
  });

  it('does not reload the project when the turn changed nothing', async () => {
    const api = fakeAssistantApi();
    const { onChanged } = mount(api);
    await ready();
    await sendText(userEvent.setup(), 'Ringkas proyek ini');
    // The server saved both turns; the refresh after `done` swaps the optimistic pair for them once.
    api.setTurns([turn({ id: 't_u1', role: 'user', text: 'Ringkas proyek ini' }), turn({ id: 't_a1', role: 'assistant', text: 'Ringkasan.' })]);
    act(() => { api.streams[0]!.push(ev('turn', { id: 't_a1' }) + ev('delta', { text: 'Ringkasan.' }) + ev('done', { rev: 2 })); api.streams[0]!.end(); });
    expect(await screen.findByText('Ringkasan.')).toBeInTheDocument();
    await waitFor(() => expect(api.calls.filter(c => c.method === 'GET')).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText('Ringkas proyek ini')).toHaveLength(1));
    expect(screen.getAllByText('Ringkasan.')).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Batalkan posts the undo and shows Dibatalkan; a 409 shows the server message under the chip', async () => {
    const api = fakeAssistantApi({
      turns: [
        turn({ id: 't1', role: 'assistant', text: 'Selesai.', changes: [{ label: 'Shot 3 diubah', undoId: 'snap_a' }] }),
        turn({ id: 't2', role: 'assistant', text: 'Juga.', changes: [{ label: 'Shot 1 dihapus', undoId: 'snap_b' }] })
      ],
      undo: id => (id === 'snap_b'
        ? new Response(JSON.stringify({ error: { code: 'STALE', message: 'Ada perubahan setelah ini — batalkan yang terbaru dulu' } }), { status: 409 })
        : new Response(JSON.stringify({ ok: true, rev: 5, attention: [] }), { status: 200 }))
    });
    const { onChanged } = mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Batalkan: Shot 3 diubah' }));
    expect(api.calls.some(c => c.method === 'POST' && c.url === `/api/stories/${SID}/assistant/undo/snap_a`)).toBe(true);
    expect(await screen.findByText('Dibatalkan')).toBeInTheDocument();
    expect(screen.getByText('Shot 3 diubah')).toHaveClass('line-through');
    expect(screen.queryByRole('button', { name: 'Batalkan: Shot 3 diubah' })).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Batalkan: Shot 1 dihapus' }));
    expect(await screen.findByText('Ada perubahan setelah ini — batalkan yang terbaru dulu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batalkan: Shot 1 dihapus' })).toBeInTheDocument();
  });

  it('pending card: Jalankan posts {confirm} and streams; superseded is disabled; Lewati hides', async () => {
    const api = fakeAssistantApi({
      turns: [turn({
        id: 't1', role: 'assistant', text: 'Siap render.',
        pending: [
          { id: 'p_old', label: 'Render scene 1 (2 shot)', estimate: { credits: 20 }, superseded: true },
          { id: 'p_run', label: 'Render scene 2 (4 shot)', estimate: { credits: 40 }, createdAt: new Date().toISOString() },
          { id: 'p_usd', label: 'Buat sheet Jingga', estimate: { usd: 0.42 }, createdAt: new Date().toISOString() }
        ]
      })]
    });
    const { onChanged } = mount(api);
    const user = userEvent.setup();
    const old = await screen.findByRole('group', { name: 'Persetujuan: Render scene 1 (2 shot)' });
    expect(within(old).getByText('Sudah tidak berlaku')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: /Jalankan/ })).toBeNull();
    expect(screen.getByText('±40 kredit Flow')).toBeInTheDocument();
    expect(screen.getByText('≈ $0,42')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Lewati: Buat sheet Jingga' }));
    expect(screen.queryByRole('group', { name: 'Persetujuan: Buat sheet Jingga' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Jalankan: Render scene 2 (4 shot)' }));
    expect(api.posts()[0]!.body).toEqual({ confirm: 'p_run' });
    expect(screen.getByText('Jalankan: Render scene 2 (4 shot)')).toBeInTheDocument();
    act(() => {
      api.streams[0]!.push(ev('turn', { id: 't_c' }) + ev('step', { label: 'Merender scene 2' }) + ev('delta', { text: 'Render scene 2 diantrekan.' }) + ev('done', { rev: 4 }));
      api.streams[0]!.end();
    });
    expect(await screen.findByText('Render scene 2 diantrekan.')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Persetujuan: Render scene 2 (4 shot)' })).getByText('Sudah dijalankan')).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a streamed pending that is superseded later in the turn is disabled', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    await sendText(userEvent.setup(), 'Render scene 1');
    act(() => { api.streams[0]!.push(ev('turn', { id: 't_a' }) + ev('pending', { id: 'p1', label: 'Render scene 1', estimate: { credits: 20 } })); });
    expect(await screen.findByRole('button', { name: 'Jalankan: Render scene 1' })).toBeInTheDocument();
    act(() => { api.streams[0]!.push(ev('pending', { id: 'p1', label: 'Render scene 1', estimate: { credits: 20 }, superseded: true }) + ev('done', { rev: 3 })); api.streams[0]!.end(); });
    expect(await screen.findByText('Sudah tidak berlaku')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jalankan: Render scene 1' })).toBeNull();
  });

  it('a refused confirm (409 COST_CHANGED) shows the message on the card and runs nothing', async () => {
    const api = fakeAssistantApi({
      turns: [turn({ id: 't1', role: 'assistant', text: 'Siap.', pending: [{ id: 'p1', label: 'Render scene 1', estimate: { credits: 20 }, createdAt: new Date().toISOString() }] })],
      refuse: b => (b.confirm ? new Response(JSON.stringify({ error: { code: 'COST_CHANGED', message: 'Biaya sudah berubah — minta ulang' } }), { status: 409 }) : undefined)
    });
    mount(api);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Jalankan: Render scene 1' }));
    expect(await screen.findByText('Biaya sudah berubah — minta ulang')).toBeInTheDocument();
    expect(screen.queryByText('Jalankan: Render scene 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jalankan: Render scene 1' })).toBeNull();
  });

  it('attaching a png uploads it (raw body + content type) and the message carries its id', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const file = png();
    fireEvent.change(fileInput(), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('img', { name: 'Lampiran 1' })).toHaveAttribute('src', `/api/stories/${SID}/uploads/up_1.png`));
    const up = api.calls.find(c => c.url === `/api/stories/${SID}/uploads`)!;
    expect(up.raw).toBe(file);
    expect(up.headers?.['Content-Type']).toBe('image/png');
    const user = userEvent.setup();
    await sendText(user, 'Pakai ini untuk Jingga');
    expect(api.posts()[0]!.body).toEqual({ message: 'Pakai ini untuk Jingga', attachments: ['up_0000000000000001'] });
    // The bubble shows the image as a 64 px thumbnail that opens a bounded preview.
    await user.click(screen.getByRole('button', { name: 'Lihat lampiran 1' }));
    const preview = await screen.findByRole('img', { name: 'Pratinjau lampiran' });
    expect(preview.className).toContain('max-h-[70vh]');
  });

  it('removes a picked image with ×', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await screen.findByRole('img', { name: 'Lampiran 1' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hapus lampiran 1' }));
    expect(screen.queryByRole('img', { name: 'Lampiran 1' })).toBeNull();
  });

  it('refuses a .txt and an 11 MB image on the client with a plain message', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    fireEvent.change(fileInput(), { target: { files: [new File(['hi'], 'catatan.txt', { type: 'text/plain' })] } });
    expect(await screen.findByText(/catatan\.txt: File harus gambar PNG, JPEG atau WebP\./)).toBeInTheDocument();
    fireEvent.change(fileInput(), { target: { files: [png('besar.png', 11 * 1024 * 1024)] } });
    expect(await screen.findByText(/besar\.png: Gambar terlalu besar — maksimal 10 MB\./)).toBeInTheDocument();
    expect(api.calls.some(c => c.url.endsWith('/uploads'))).toBe(false);
  });

  it('pasting an image uploads it', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const file = png('tempel.png');
    fireEvent.paste(composer(), { clipboardData: { files: [file], types: ['Files'], items: [] } });
    await screen.findByRole('img', { name: 'Lampiran 1' });
    expect(api.calls.find(c => c.url.endsWith('/uploads'))!.raw).toBe(file);
  });

  it('dropping an image on the panel shows the overlay and uploads it', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const panel = screen.getByRole('region', { name: 'Asisten proyek' });
    const file = png('drop.png');
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.getByText('Lepas gambar di sini')).toBeInTheDocument();
    fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.queryByText('Lepas gambar di sini')).toBeNull();
    await screen.findByRole('img', { name: 'Lampiran 1' });
  });

  it('Enter sends, Shift+Enter adds a newline', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), 'baris satu');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(composer(), 'baris dua');
    expect(composer()).toHaveValue('baris satu\nbaris dua');
    expect(api.posts()).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect(api.posts()[0]!.body).toEqual({ message: 'baris satu\nbaris dua' });
    expect(composer()).toHaveValue('');
  });

  it('Stop aborts the stream; Escape in the composer stops too', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const user = userEvent.setup();
    await sendText(user, 'Pecah scene 1 jadi 4 shot');
    await user.click(await screen.findByRole('button', { name: 'Hentikan jawaban' }));
    expect(api.streams[0]!.signal?.aborted).toBe(true);
    expect(await screen.findByText('Dihentikan.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Kirim pesan' })).toBeInTheDocument();

    await sendText(user, 'Coba lagi dong');
    await screen.findByRole('button', { name: 'Hentikan jawaban' });
    composer().focus();
    await user.keyboard('{Escape}');
    expect(api.streams[1]!.signal?.aborted).toBe(true);
  });

  it('an error turn shows the message inline with Coba lagi that re-sends the same message', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const user = userEvent.setup();
    await sendText(user, 'Buat sheet untuk Jingga');
    act(() => { api.streams[0]!.push(ev('turn', { id: 't_e' }) + ev('error', { message: 'Model teks sedang tidak tersedia — coba lagi.', code: 'UNAVAILABLE' }) + ev('done', { rev: 2 })); api.streams[0]!.end(); });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Model teks sedang tidak tersedia — coba lagi.');
    await user.click(within(alert).getByRole('button', { name: /Coba lagi/ }));
    expect(api.posts()[1]!.body).toEqual({ message: 'Buat sheet untuk Jingga' });
  });

  it('"@" suggests characters and "/" suggests shots and scenes', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), '@');
    const people = screen.getByRole('listbox', { name: 'Karakter' });
    expect(within(people).getByRole('option', { name: /Jingga/ })).toBeInTheDocument();
    expect(within(people).getByRole('option', { name: /Bima/ })).toBeInTheDocument();
    await user.clear(composer());
    await user.type(composer(), '/');
    const shots = screen.getByRole('listbox', { name: 'Shot dan scene' });
    expect(within(shots).getByRole('option', { name: 'Shot 3 · Pulang' })).toBeInTheDocument();
    await user.type(composer(), 'scene');
    await user.click(screen.getByRole('option', { name: 'Scene 2 · Pulang' }));
    expect(composer()).toHaveValue('scene 2 ');
  });

  it('renders markdown: lists, bold, links in a new tab', async () => {
    const api = fakeAssistantApi({ turns: [turn({ id: 't1', role: 'assistant', text: 'Rencana:\n\n- **satu**\n- dua\n\n[contoh](https://example.com)' })] });
    const { container } = mount(api);
    expect(await screen.findByText('satu')).toBeInTheDocument();
    expect(container.querySelectorAll('ol[role=log] ul > li')).toHaveLength(2);
    expect(screen.getByText('satu').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'contoh' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('never renders raw HTML from the model as elements (XSS)', async () => {
    const api = fakeAssistantApi({ turns: [turn({ id: 't1', role: 'assistant', text: 'Lihat ini:\n\n<img src=x onerror=alert(1)>\n\n<script>alert(2)</script> selesai' })] });
    const { container } = mount(api);
    expect(await screen.findByText(/Lihat ini/)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('ol[role=log] script')).toBeNull();
  });

  it('not configured: one line with a link to Pengaturan › Provider, no composer', async () => {
    const api = fakeAssistantApi({ configured: false });
    mount(api);
    const link = await screen.findByRole('link', { name: 'Pengaturan › Provider' });
    expect(link).toHaveAttribute('href', '/pengaturan/provider');
    expect(screen.getByText(/Asisten butuh model teks — atur di/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Pesan untuk asisten' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kirim pesan' })).toBeNull();
  });

  it('a NOT_CONFIGURED error during a turn swaps the composer for the settings line', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    await sendText(userEvent.setup(), 'Halo');
    api.setConfigured(false);
    act(() => {
      api.streams[0]!.push(ev('turn', { id: 't_n' }) + ev('error', { message: 'Asisten butuh model teks — atur di Pengaturan › Provider.', code: 'NOT_CONFIGURED' }) + ev('done', { rev: 2 }));
      api.streams[0]!.end();
    });
    expect(await screen.findByRole('link', { name: 'Pengaturan › Provider' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Pesan untuk asisten' })).toBeNull();
  });

  it('an MCP entry shows "MCP · <token name>" instead of the assistant mark', async () => {
    const api = fakeAssistantApi({ turns: [turn({ id: 't1', role: 'assistant', text: 'Shot 2 diubah', source: 'mcp', by: 'Claude Code laptop', changes: [{ label: 'Shot 2 diubah', undoId: 'u9' }] })] });
    mount(api);
    expect(await screen.findByText('MCP · Claude Code laptop')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Perubahan lewat MCP · Claude Code laptop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batalkan: Shot 2 diubah' })).toBeInTheDocument();
  });

  it('empty state: suggestion chips from the real project fill the composer without sending', async () => {
    const api = fakeAssistantApi();
    mount(api);
    expect(await screen.findByText('Tanya atau suruh apa saja tentang proyek ini.')).toBeInTheDocument();
    const chips = within(screen.getByLabelText('Contoh perintah')).getAllByRole('button').map(b => b.textContent);
    expect(chips).toEqual(['Pecah scene 1 jadi 4 shot', 'Di shot 2, buat Jingga lebih lega', 'Buat sheet untuk Jingga']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Di shot 2, buat Jingga lebih lega' }));
    expect(composer()).toHaveValue('Di shot 2, buat Jingga lebih lega');
    expect(api.posts()).toHaveLength(0);
  });

  it('empty state falls back to general questions when the project lacks the data', async () => {
    const api = fakeAssistantApi();
    const board = { ...BOARD, characters: {}, bible: undefined, shots: BOARD.shots.slice(0, 1), scenes: [{ id: 's', title: 'S', shots: [BOARD.shots[0]!.id] }] };
    mount(api, { board, story: { ...storyFor(board), id: SID, mode: 'cepat' } });
    await screen.findByText('Tanya atau suruh apa saja tentang proyek ini.');
    const chips = within(screen.getByLabelText('Contoh perintah')).getAllByRole('button').map(b => b.textContent);
    expect(chips).toEqual(['Ringkas proyek ini', 'Apa langkah berikutnya?']);
  });

  it('has no native select/date/radio/checkbox and the composer has its placeholder', async () => {
    const api = fakeAssistantApi();
    mount(api);
    await ready();
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
    expect(composer()).toHaveAttribute('placeholder', PLACEHOLDER);
    expect(screen.getByRole('button', { name: 'Kirim pesan' })).toBeDisabled();
  });
});

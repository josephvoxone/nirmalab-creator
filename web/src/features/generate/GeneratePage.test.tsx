import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import GeneratePage from './GeneratePage.js';
import { buildScriptRequest } from './scriptTemplates.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin: User = { id: 'u1', email: 'joseph@example.com', isAdmin: true };

function HomeProbe() {
  const location = useLocation();
  return <p data-testid="home">{location.pathname + location.search}</p>;
}

function renderPage(fetchImpl: ReturnType<typeof fakeFetch>, user: User = admin) {
  return render(
    <SessionContext.Provider value={{ user, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={['/generate']}>
        <Routes>
          <Route path="/generate" element={<GeneratePage />} />
          <Route path="/" element={<HomeProbe />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
const calls = (f: ReturnType<typeof fakeFetch>, url: string) => f.mock.calls.filter(([u]) => u === url);
const stepButton = (name: RegExp) => within(screen.getByRole('list', { name: 'Langkah' })).getByRole('button', { name });

function mockClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

async function pick(label: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** Happy-path server: models, text and tts all answer. */
function okServer(overrides: Partial<Record<string, Handler>> = {}) {
  return fakeFetch((url, init) => {
    const custom = overrides[url];
    if (custom) return custom(url, init);
    if (url === '/api/generate/models') return { status: 200, body: { models: ['openai', 'mistral'] } };
    if (url === '/api/generate/text') return { status: 200, body: { ok: true, text: 'Kucing suka kotak.\nKarena hangat.', model: 'openai' } };
    if (url === '/api/generate/tts') return { status: 200, body: { ok: true, filePath: '/data/free-generate/tts/tts-1-2.mp3', bytes: 20480, url: '/api/generate/files/tts/tts-1-2.mp3' } };
    return { status: 404, body: {} };
  });
}

async function writeScript(topic = 'kenapa kucing suka kotak') {
  await userEvent.type(screen.getByLabelText('Topik / ide'), topic);
  await userEvent.click(screen.getByRole('button', { name: 'Tulis naskah' }));
  return screen.findByLabelText('Naskah');
}

describe('GeneratePage — Naskah & suara', () => {
  it('says what the page is for, shows the three steps and no native select or image card', async () => {
    renderPage(okServer());
    expect(screen.getByText(/narasi atau caption.*voice-over.*gratis/i)).toBeInTheDocument();
    expect(stepButton(/naskah/i)).toHaveAttribute('aria-current', 'step');
    expect(stepButton(/suara/i)).toBeDisabled();
    expect(stepButton(/pakai/i)).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Narasi video pendek' })).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Hook pembuka', 'Caption & hashtag', 'Bebas']) expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Otomatis'));
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByText(/gambar/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buat gambar/i })).not.toBeInTheDocument();
    expect(screen.getByText(/belum ada naskah/i)).toBeInTheDocument();
  });

  it('step 1: sends the chosen kind template and model, shows an editable result, copies and repeats', async () => {
    const writeText = mockClipboard();
    let n = 0;
    const fetchImpl = okServer({
      '/api/generate/text': () => ({ status: 200, body: { ok: true, text: n++ === 0 ? '1. Hook satu' : '1. Hook baru', model: 'mistral' } })
    });
    renderPage(fetchImpl);
    await userEvent.click(screen.getByRole('radio', { name: 'Hook pembuka' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled());
    await pick('Model', 'mistral');
    const result = await writeScript('tips hemat listrik');
    const expected = buildScriptRequest('hook', 'tips hemat listrik');
    expect(bodyOf(calls(fetchImpl, '/api/generate/text')[0]![1])).toEqual({ prompt: expected.prompt, system: expected.system, model: 'mistral' });
    expect(result).toHaveValue('1. Hook satu');
    await userEvent.type(result, ' edit');
    await userEvent.click(screen.getByRole('button', { name: 'Salin' }));
    expect(writeText).toHaveBeenCalledWith('1. Hook satu edit');
    await userEvent.click(screen.getByRole('button', { name: 'Ulangi' }));
    await waitFor(() => expect(screen.getByLabelText('Naskah')).toHaveValue('1. Hook baru'));
    expect(calls(fetchImpl, '/api/generate/text')).toHaveLength(2);
  });

  it('step 1: Otomatis sends no model at all', async () => {
    const fetchImpl = okServer();
    renderPage(fetchImpl);
    await writeScript('kopi pagi');
    const body = bodyOf(calls(fetchImpl, '/api/generate/text')[0]![1]);
    expect(body).not.toHaveProperty('model');
    expect(body.system).toBe(buildScriptRequest('narasi', 'kopi pagi').system);
  });

  it('step 1: keeps Otomatis usable when the model list fails, and can reload it', async () => {
    let fail = true;
    const fetchImpl = okServer({
      '/api/generate/models': () => (fail ? { status: 503, body: { error: { code: 'GENERATE_FAILED', message: 'down' } } } : { status: 200, body: { models: ['mistral'] } })
    });
    renderPage(fetchImpl);
    expect(await screen.findByText(/daftar model gagal dimuat/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Otomatis');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Muat ulang model' }));
    await waitFor(() => expect(screen.queryByText(/daftar model gagal dimuat/i)).not.toBeInTheDocument());
    await pick('Model', 'mistral');
  });

  it('step 1: a failed text call explains the cause in plain words and Coba lagi retries', async () => {
    let fail = true;
    const fetchImpl = okServer({
      '/api/generate/text': () => (fail
        ? { status: 503, body: { error: { code: 'GENERATE_FAILED', message: 'Pollinations sedang sibuk' } } }
        : { status: 200, body: { ok: true, text: 'Naskah jadi.', model: 'openai' } })
    });
    renderPage(fetchImpl);
    await userEvent.type(screen.getByLabelText('Topik / ide'), 'Halo');
    await userEvent.click(screen.getByRole('button', { name: 'Tulis naskah' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Naskah gagal dibuat');
    expect(alert).toHaveTextContent('Server sedang bermasalah: Pollinations sedang sibuk');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByLabelText('Naskah')).toHaveValue('Naskah jadi.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('step 2: carries the (edited) script over, sends the voice chosen via Choice, plays and offers a download', async () => {
    const fetchImpl = okServer();
    renderPage(fetchImpl);
    const script = await writeScript();
    await userEvent.clear(script);
    await userEvent.type(script, '**Kucing** suka kotak. #fyp');
    await userEvent.click(screen.getByRole('button', { name: 'Lanjut ke suara' }));
    expect(stepButton(/suara/i)).toHaveAttribute('aria-current', 'step');
    const text = screen.getByLabelText('Teks untuk dibacakan');
    expect(text).toHaveValue('Kucing suka kotak.');
    await userEvent.type(text, ' Selesai.');
    expect(screen.getByRole('combobox', { name: 'Suara' })).toHaveTextContent('Indonesia (Gadis)');
    await pick('Suara', 'English (Aria)');
    await userEvent.click(screen.getByRole('button', { name: 'Buat suara' }));
    await waitFor(() => expect(document.querySelector('audio')).toHaveAttribute('src', '/api/generate/files/tts/tts-1-2.mp3'));
    expect(bodyOf(calls(fetchImpl, '/api/generate/tts')[0]![1])).toEqual({ text: 'Kucing suka kotak. Selesai.', voice: 'en-US-AriaNeural' });
    expect(document.querySelector('audio')).toHaveAttribute('controls');
    const download = screen.getByRole('link', { name: /unduh/i });
    expect(download).toHaveAttribute('href', '/api/generate/files/tts/tts-1-2.mp3');
    expect(download).toHaveAttribute('download', 'tts-1-2.mp3');
    expect(screen.getByText(/20 KB/)).toBeInTheDocument();
  });

  it('step 2: going back to Naskah and forward again keeps voice edits when the script did not change', async () => {
    renderPage(okServer());
    await writeScript();
    await userEvent.click(screen.getByRole('button', { name: 'Lanjut ke suara' }));
    await userEvent.type(screen.getByLabelText('Teks untuk dibacakan'), ' Tambahan.');
    await userEvent.click(stepButton(/naskah/i));
    await userEvent.click(screen.getByRole('button', { name: 'Lanjut ke suara' }));
    expect(screen.getByLabelText('Teks untuk dibacakan')).toHaveValue('Kucing suka kotak.\nKarena hangat. Tambahan.');
  });

  it('step 2: a failed TTS call shows the cause and Coba lagi retries', async () => {
    let fail = true;
    const fetchImpl = okServer({
      '/api/generate/tts': () => (fail
        ? { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'Teks terlalu panjang' } } }
        : { status: 200, body: { ok: true, filePath: '/d/tts-9.mp3', bytes: 1000, url: '/api/generate/files/tts/tts-9.mp3' } })
    });
    renderPage(fetchImpl);
    await userEvent.click(screen.getByRole('button', { name: /langsung ke suara/i }));
    await userEvent.type(screen.getByLabelText('Teks untuk dibacakan'), 'Halo dunia');
    await userEvent.click(screen.getByRole('button', { name: 'Buat suara' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Suara gagal dibuat');
    expect(alert).toHaveTextContent('Teks terlalu panjang');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    await waitFor(() => expect(document.querySelector('audio')).toHaveAttribute('src', '/api/generate/files/tts/tts-9.mp3'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls(fetchImpl, '/api/generate/tts')).toHaveLength(2);
  });

  it('step 3: copies the script and hands it to the home page as ?prompt=', async () => {
    const writeText = mockClipboard();
    renderPage(okServer());
    await writeScript();
    await userEvent.click(screen.getByRole('button', { name: 'Lanjut ke suara' }));
    const text = screen.getByLabelText('Teks untuk dibacakan');
    await userEvent.clear(text);
    await userEvent.type(text, 'Kucing & kotak?');
    await userEvent.click(screen.getByRole('button', { name: 'Lanjut' }));
    expect(stepButton(/pakai/i)).toHaveAttribute('aria-current', 'step');
    await userEvent.click(screen.getByRole('button', { name: 'Salin naskah' }));
    expect(writeText).toHaveBeenCalledWith('Kucing & kotak?');
    await userEvent.click(screen.getByRole('button', { name: /jadikan video cerita/i }));
    expect(await screen.findByTestId('home')).toHaveTextContent('/?prompt=' + encodeURIComponent('Kucing & kotak?'));
  });

  it('non-admin: sees the whole flow read-only with a clear notice', async () => {
    const fetchImpl = okServer();
    renderPage(fetchImpl, { ...admin, isAdmin: false });
    expect(screen.getByText(/hanya admin yang bisa membuat naskah dan suara/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Topik / ide'), 'Halo');
    expect(screen.getByRole('button', { name: 'Tulis naskah' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /langsung ke suara/i }));
    await userEvent.type(screen.getByLabelText('Teks untuk dibacakan'), 'Halo');
    expect(screen.getByRole('button', { name: 'Buat suara' })).toBeDisabled();
    expect(calls(fetchImpl, '/api/generate/text')).toHaveLength(0);
    expect(calls(fetchImpl, '/api/generate/tts')).toHaveLength(0);
  });
});

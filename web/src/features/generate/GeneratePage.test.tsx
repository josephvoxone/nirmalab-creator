import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import GeneratePage from './GeneratePage.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin: User = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };

function renderPage(fetchImpl: ReturnType<typeof fakeFetch>, user: User = admin) {
  return render(
    <SessionContext.Provider value={{ user, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><GeneratePage /></MemoryRouter>
    </SessionContext.Provider>
  );
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));

describe('GeneratePage', () => {
  it('loads models and generates text with the chosen model, then copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/generate/models') return { status: 200, body: { models: ['openai', 'mistral'] } };
      if (url === '/api/generate/text' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ prompt: 'Tulis hook', model: 'mistral' });
        return { status: 200, body: { ok: true, text: 'Hook yang bagus', model: 'mistral' } };
      }
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: 'Teks' });
    const select = within(card).getByLabelText(/model/i);
    await waitFor(() => expect(within(select).getByRole('option', { name: 'mistral' })).toBeInTheDocument());
    await userEvent.selectOptions(select, 'mistral');
    await userEvent.type(within(card).getByLabelText(/prompt/i), 'Tulis hook');
    await userEvent.click(within(card).getByRole('button', { name: /buat teks/i }));
    expect(await within(card).findByText('Hook yang bagus')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /salin/i }));
    expect(writeText).toHaveBeenCalledWith('Hook yang bagus');
  });

  it('shows the server error message when text generation fails', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/generate/models') return { status: 200, body: { models: [] } };
      if (url === '/api/generate/text') return { status: 503, body: { error: { code: 'GENERATE_FAILED', message: 'Pollinations sedang sibuk' } } };
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: 'Teks' });
    await userEvent.type(within(card).getByLabelText(/prompt/i), 'Halo');
    await userEvent.click(within(card).getByRole('button', { name: /buat teks/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Pollinations sedang sibuk');
  });

  it('synthesizes speech with the chosen voice and reports the saved file', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/generate/models') return { status: 200, body: { models: [] } };
      if (url === '/api/generate/tts' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ text: 'Halo dunia', voice: 'en-US-AriaNeural' });
        return { status: 200, body: { ok: true, filePath: '/data/free-generate/tts/tts-1-2.mp3', bytes: 20480 } };
      }
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: 'Suara' });
    await userEvent.selectOptions(within(card).getByLabelText(/suara/i), 'en-US-AriaNeural');
    await userEvent.type(within(card).getByLabelText(/teks/i), 'Halo dunia');
    await userEvent.click(within(card).getByRole('button', { name: /buat suara/i }));
    expect(await within(card).findByText('tts-1-2.mp3')).toBeInTheDocument();
    expect(within(card).getByText(/20 KB/)).toBeInTheDocument();
  });

  it('plays the audio when the server returns a URL for it', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url === '/api/generate/models') return { status: 200, body: { models: [] } };
      if (url === '/api/generate/tts') return { status: 200, body: { ok: true, filePath: '/d/tts-9.mp3', bytes: 1000, url: '/api/generate/files/tts-9.mp3' } };
      return { status: 404, body: {} };
    });
    const { container } = renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: 'Suara' });
    await userEvent.type(within(card).getByLabelText(/teks/i), 'Halo');
    await userEvent.click(within(card).getByRole('button', { name: /buat suara/i }));
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', '/api/generate/files/tts-9.mp3'));
  });

  it('generates an image and shows the server error when it fails', async () => {
    let fail = true;
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/generate/models') return { status: 200, body: { models: [] } };
      if (url === '/api/generate/image' && init?.method === 'POST') {
        expect(bodyOf(init)).toEqual({ prompt: 'kucing oranye' });
        return fail
          ? { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'Prompt terlalu pendek' } } }
          : { status: 200, body: { ok: true, filePath: '/d/pollinations-1.jpg', bytes: 51200, url: '/api/generate/files/p1.jpg' } };
      }
      return { status: 404, body: {} };
    });
    renderPage(fetchImpl);
    const card = screen.getByRole('region', { name: 'Gambar' });
    await userEvent.type(within(card).getByLabelText(/prompt/i), 'kucing oranye');
    await userEvent.click(within(card).getByRole('button', { name: /buat gambar/i }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Prompt terlalu pendek');
    fail = false;
    await userEvent.click(within(card).getByRole('button', { name: /buat gambar/i }));
    expect(await within(card).findByRole('img', { name: /kucing oranye/i })).toHaveAttribute('src', '/api/generate/files/p1.jpg');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tells a non-admin member that generating is admin-only', async () => {
    const fetchImpl = fakeFetch(url => (url === '/api/generate/models' ? { status: 200, body: { models: [] } } : { status: 403, body: {} }));
    renderPage(fetchImpl, { ...admin, isAdmin: false });
    expect(screen.getByText(/hanya admin/i)).toBeInTheDocument();
    for (const name of [/buat teks/i, /buat suara/i, /buat gambar/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

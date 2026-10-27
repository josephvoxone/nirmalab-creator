import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import { TextModelPanel } from './TextModelPanel.js';
import type { TextModelState } from './settingsClient.js';

type Reply = { status: number; body: unknown };
const admin: User = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };
const SECRET = 'fake-opencode-key-0000abcd';
const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });

function fake(opts: { state?: TextModelState; gets?: Reply[]; test?: Reply; hang?: boolean } = {}) {
  let state: TextModelState = structuredClone(opts.state ?? { configured: false, model: 'glm-5.3' });
  const gets = [...(opts.gets ?? [])];
  const puts: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/providers/text' && method === 'GET') {
      if (opts.hang) return new Promise<Response>(() => undefined);
      return json(gets.shift() ?? { status: 200, body: state });
    }
    if (url === '/api/providers/text' && method === 'PUT') {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      puts.push(b);
      if (typeof b.apiKey === 'string') state = { ...state, configured: true, keyHint: `••••${b.apiKey.slice(-4)}` };
      if (typeof b.model === 'string') state = { ...state, model: b.model as TextModelState['model'] };
      return json({ status: 200, body: state });
    }
    if (url === '/api/providers/text/test' && method === 'POST') return json(opts.test ?? { status: 200, body: { ok: true, model: 'glm-5.3', ms: 840 } });
    return json({ status: 404, body: { error: { message: `no fake for ${method} ${url}` } } });
  });
  return { fetchImpl, puts };
}

const open = (f: ReturnType<typeof fake>) => render(
  <SessionContext.Provider value={{ user: admin, fetchImpl: f.fetchImpl, signOut: async () => undefined }}>
    <TextModelPanel />
  </SessionContext.Provider>
);
const region = () => screen.getByRole('region', { name: /model teks/i });
const secretShown = () => document.body.innerHTML.includes(SECRET) || [...document.querySelectorAll('input')].some(i => i.value === SECRET);

describe('Pengaturan › Provider › Model teks', () => {
  it('shows a skeleton while loading', () => {
    open(fake({ hang: true }));
    expect(screen.getByRole('status', { name: /memuat model teks/i })).toBeInTheDocument();
  });

  it('without a key says why and saves the key write-only (PUT body, then only the hint)', async () => {
    const user = userEvent.setup();
    const f = fake();
    open(f);
    expect(await within(region()).findByText(/belum ada key/i)).toBeInTheDocument();
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
    const input = within(region()).getByLabelText(/api key opencode go/i);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('placeholder', 'sk-…');
    expect(within(region()).getByRole('button', { name: /^tes/i })).toBeDisabled();
    await user.type(input, SECRET);
    await user.click(within(region()).getByRole('button', { name: /simpan key/i }));
    expect(await within(region()).findByText('Tersimpan · …abcd')).toBeInTheDocument();
    expect(f.puts).toEqual([{ apiKey: SECRET }]);
    expect(input).toHaveValue('');
    expect(secretShown()).toBe(false);
  });

  it('picks the model from a Choice with hints and saves it', async () => {
    const user = userEvent.setup();
    const f = fake({ state: { configured: true, keyHint: '••••abcd', model: 'glm-5.3' } });
    open(f);
    await user.click(await within(region()).findByRole('combobox', { name: 'Model' }));
    expect(await screen.findByRole('option', { name: /^glm-5\.3 ?andal untuk aksi/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^beam-free ?gratis/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^deepseek-v4-pro ?alternatif/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /^glm-5\.3-flash ?cepat/i }));
    await waitFor(() => expect(f.puts).toEqual([{ model: 'glm-5.3-flash' }]));
    await waitFor(() => expect(within(region()).getByRole('combobox', { name: 'Model' })).toHaveTextContent('glm-5.3-flash'));
  });

  it('Tes shows the model and time, or the plain error', async () => {
    const user = userEvent.setup();
    open(fake({ state: { configured: true, keyHint: '••••abcd', model: 'glm-5.3' } }));
    await user.click(await within(region()).findByRole('button', { name: /^tes/i }));
    expect(await within(region()).findByRole('status')).toHaveTextContent('Terhubung · glm-5.3 · 840 ms');
  });

  it('Tes failing shows the server message', async () => {
    const user = userEvent.setup();
    open(fake({ state: { configured: true, keyHint: '••••abcd', model: 'glm-5.3' }, test: { status: 502, body: { error: { code: 'UNAVAILABLE', message: 'Model teks sedang tidak tersedia' } } } }));
    await user.click(await within(region()).findByRole('button', { name: /^tes/i }));
    expect(await within(region()).findByRole('alert')).toHaveTextContent(/tes gagal.*model teks sedang tidak tersedia/i);
  });

  it('a failed load explains it and Coba lagi reloads', async () => {
    const user = userEvent.setup();
    open(fake({ gets: [{ status: 500, body: { error: { message: 'disk penuh' } } }] }));
    const alert = await within(region()).findByRole('alert');
    expect(alert).toHaveTextContent(/model teks gagal dimuat/i);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(region()).findByText(/belum ada key/i)).toBeInTheDocument();
  });
});

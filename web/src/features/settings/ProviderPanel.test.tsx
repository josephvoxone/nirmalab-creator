import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import SettingsPage from './SettingsPage.js';
import { App } from '../../App.js';
import { CONFIGURED, MODELS, UNCONFIGURED } from '../providers/fixtures.js';
import type { Providers } from '../providers/providersClient.js';

type Reply = { status: number; body: unknown };
const admin: User = { id: 'u1', email: 'joseph@example.com', isAdmin: true };
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
const SECRET = 'sk-or-v1-supersecret1234';

function fake(opts: { providers?: Providers; get?: Reply; models?: Reply[]; test?: Reply; modelsHang?: boolean } = {}) {
  let providers = structuredClone(opts.providers ?? CONFIGURED);
  const modelReplies = [...(opts.models ?? [])];
  const puts: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/providers' && method === 'GET') return reply(opts.get ?? { status: 200, body: providers });
    if (url === '/api/providers/openrouter' && method === 'PUT') {
      const b = bodyOf(init);
      puts.push(b);
      const or = providers.openrouter;
      if ('apiKey' in b) providers.openrouter = b.apiKey ? { ...or, configured: true, keyHint: `••••${String(b.apiKey).slice(-4)}` } : { configured: false, defaults: or.defaults };
      if (b.defaults) providers.openrouter = { ...providers.openrouter, defaults: { ...providers.openrouter.defaults, ...b.defaults } };
      return reply({ status: 200, body: providers.openrouter });
    }
    if (url === '/api/providers/openrouter/test' && method === 'POST') return reply(opts.test ?? { status: 200, body: { ok: true, balance: { usedUsd: 1.25, limitUsd: 10, remainingUsd: 8.75 } } });
    if (url === '/api/providers/openrouter/models' && opts.modelsHang) return new Promise<Response>(() => undefined);
    if (url === '/api/providers/openrouter/models') return reply(modelReplies.shift() ?? { status: 200, body: MODELS });
    if (url === '/api/providers/text' && method === 'GET') return reply({ status: 200, body: { configured: false, model: 'glm-5.3' } });
    if (url === '/api/flow/accounts') return reply({ status: 200, body: { accounts: [], bridge: { online: true } } });
    if (url === '/api/flow/pool') return reply({ status: 200, body: { pool: { rotation: 'least-used' } } });
    return reply({ status: 404, body: { error: { message: `no fake for ${method} ${url}` } } });
  });
  return { fetchImpl, puts };
}

function open(f: ReturnType<typeof fake>, user: User = admin) {
  return render(
    <SessionContext.Provider value={{ user, fetchImpl: f.fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab="provider" /></MemoryRouter>
    </SessionContext.Provider>
  );
}

const openRouter = () => screen.getByRole('region', { name: /openrouter/i });
const secretShown = () => document.body.innerHTML.includes(SECRET) || [...document.querySelectorAll('input')].some(i => i.value === SECRET);

describe('Pengaturan › Provider', () => {
  it('explains both engines in one line and summarises Google Flow with a link to Akun Flow', async () => {
    const user = userEvent.setup();
    open(fake());
    expect(screen.getByRole('tab', { name: 'Provider' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/atur mesin pembuat gambar & video.*dipilih saat mulai membuat/i)).toBeInTheDocument();
    const flow = await screen.findByRole('region', { name: /google flow/i });
    expect(await within(flow).findByText(/3 akun · 450 kredit · bridge online/i)).toBeInTheDocument();
    expect(within(flow).queryByRole('button', { name: /tambah akun/i })).toBeNull();
    await user.click(within(flow).getByRole('button', { name: /kelola di akun flow/i }));
    expect(screen.getByRole('tab', { name: 'Akun Flow' })).toHaveAttribute('aria-selected', 'true');
  });

  it('saves a new key write-only: password field, PUT body, then only the hint comes back', async () => {
    const user = userEvent.setup();
    const f = fake({ providers: UNCONFIGURED });
    open(f);
    const field = await within(await screen.findByRole('region', { name: /openrouter/i })).findByLabelText(/api key openrouter/i);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('placeholder', 'sk-or-v1-…');
    expect(within(openRouter()).queryByRole('button', { name: /tes koneksi/i })).toBeNull();
    await user.type(field, SECRET);
    await user.click(within(openRouter()).getByRole('button', { name: /simpan key/i }));
    await waitFor(() => expect(f.puts).toEqual([{ apiKey: SECRET }]));
    expect(await within(openRouter()).findByText('Tersimpan ••••1234')).toBeInTheDocument();
    expect(secretShown()).toBe(false);
  });

  it('a saved key shows only its hint; Ganti and Hapus go through a dialog', async () => {
    const user = userEvent.setup();
    const f = fake();
    open(f);
    expect(await within(await screen.findByRole('region', { name: /openrouter/i })).findByText('Tersimpan ••••c0de')).toBeInTheDocument();
    expect(within(openRouter()).queryByLabelText(/api key openrouter/i)).toBeNull();

    await user.click(within(openRouter()).getByRole('button', { name: /^ganti/i }));
    const dialog = await screen.findByRole('alertdialog');
    const field = within(dialog).getByLabelText(/api key baru/i);
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, SECRET);
    await user.click(within(dialog).getByRole('button', { name: /simpan key/i }));
    await waitFor(() => expect(f.puts).toEqual([{ apiKey: SECRET }]));
    expect(await within(openRouter()).findByText('Tersimpan ••••1234')).toBeInTheDocument();
    expect(secretShown()).toBe(false);

    await user.click(within(openRouter()).getByRole('button', { name: /^hapus/i }));
    expect(f.puts).toHaveLength(1);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /ya, hapus key/i }));
    await waitFor(() => expect(f.puts.at(-1)).toEqual({ apiKey: null }));
    expect(await within(openRouter()).findByLabelText(/api key openrouter/i)).toBeInTheDocument();
  });

  it('Tes koneksi shows the balance in USD, and the server reason when it fails', async () => {
    const user = userEvent.setup();
    open(fake());
    await user.click(await within(await screen.findByRole('region', { name: /openrouter/i })).findByRole('button', { name: /tes koneksi/i }));
    expect(await within(openRouter()).findByRole('status')).toHaveTextContent('Terhubung · terpakai $1,25 · batas $10,00 · sisa $8,75');
  });

  it('Tes koneksi failure shows the server text', async () => {
    const user = userEvent.setup();
    open(fake({ test: { status: 400, body: { error: 'API key OpenRouter ditolak' } } }));
    await user.click(await within(await screen.findByRole('region', { name: /openrouter/i })).findByRole('button', { name: /tes koneksi/i }));
    expect(await within(openRouter()).findByRole('alert')).toHaveTextContent('API key OpenRouter ditolak');
  });

  it('picks default models: video list cheapest first, unknown last, marks keyframe + audio', async () => {
    const user = userEvent.setup();
    const f = fake();
    open(f);
    const video = await within(await screen.findByRole('region', { name: /openrouter/i })).findByRole('combobox', { name: /model video bawaan/i });
    expect(video).toHaveTextContent('Veo 3.1 Lite');
    await user.click(video);
    const options = await screen.findAllByRole('option');
    expect(options.map(o => o.textContent?.split('±')[0].split('harga')[0].trim())).toEqual(['Veo 3.1 Lite', 'Kling 2', 'Veo 3.1', 'Mystery Video']);
    expect(options[0]).toHaveTextContent(/±\$0,30 \/ klip 6 dtk · keyframe \+ audio/);
    expect(options[1]).not.toHaveTextContent(/keyframe \+ audio/);
    await user.click(screen.getByRole('option', { name: /^Veo 3\.1 ?±\$2,40/ }));
    await waitFor(() => expect(f.puts).toEqual([{ defaults: { video: 'google/veo-3.1' } }]));
    expect(video).toHaveTextContent('Veo 3.1');

    await user.click(within(openRouter()).getByRole('combobox', { name: /model gambar bawaan/i }));
    await user.click(await screen.findByRole('option', { name: /^GPT Image 1/ }));
    await waitFor(() => expect(f.puts.at(-1)).toEqual({ defaults: { image: 'openai/gpt-image-1' } }));
    expect(document.querySelector('select')).toBeNull();
  });

  it('model list: error with Coba lagi, then empty explains why', async () => {
    const user = userEvent.setup();
    open(fake({ models: [{ status: 502, body: { error: { message: 'OpenRouter tidak menjawab' } } }, { status: 200, body: { image: [], video: [] } }] }));
    const alert = await within(await screen.findByRole('region', { name: /openrouter/i })).findByRole('alert');
    expect(alert).toHaveTextContent(/daftar model gagal dimuat/i);
    expect(alert).toHaveTextContent(/OpenRouter tidak menjawab/);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(openRouter()).findByText(/belum ada model/i)).toBeInTheDocument();
  });

  it('model list shows a labelled skeleton while loading', async () => {
    open(fake({ modelsHang: true }));
    const skel = await screen.findByRole('status', { name: /memuat model/i });
    expect(skel).toHaveAttribute('aria-busy', 'true');
  });

  it('provider state failing to load says why and retries', async () => {
    const user = userEvent.setup();
    open(fake({ get: { status: 500, body: { error: { message: 'disk penuh' } } } }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/provider gagal dimuat/i);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
  });

  it('is admin only: a member has no Provider tab and loads nothing', async () => {
    const f = fake();
    open(f, { ...admin, isAdmin: false });
    expect(screen.queryByRole('tab', { name: 'Provider' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Umum' })).toHaveAttribute('aria-selected', 'true');
    await new Promise(r => setTimeout(r, 20));
    expect(f.fetchImpl.mock.calls.filter(([u]) => String(u).includes('/api/providers'))).toEqual([]);
  });
});

describe('Pengaturan › Provider route', () => {
  it.each([[true, 'Provider'], [false, 'Umum']])('/pengaturan/provider for admin=%s opens on %s', async (isAdmin, selected) => {
    const f = fake();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return new Response(JSON.stringify({ user: { ...admin, isAdmin } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/stories') return new Response(JSON.stringify({ stories: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return f.fetchImpl(url, init);
    });
    render(<App fetchImpl={fetchImpl} initialPath="/pengaturan/provider" />);
    const dialog = await screen.findByRole('dialog', { name: /pengaturan/i });
    expect(within(dialog).getByRole('tab', { name: selected })).toHaveAttribute('aria-selected', 'true');
    if (isAdmin) expect(await within(dialog).findByRole('region', { name: /openrouter/i })).toBeInTheDocument();
    else expect(within(dialog).queryByRole('tab', { name: 'Provider' })).toBeNull();
  });
});

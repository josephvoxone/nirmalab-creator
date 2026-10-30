import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import { KeyPoolPanel } from './KeyPoolPanel.js';
import type { KeyPools, PoolKeyView } from './keyPoolClient.js';

const admin: User = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };
const SECRET = 'sk_live_super_secret_9999';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const key = (n: number, extra: Partial<PoolKeyView> = {}): PoolKeyView => ({ id: `k${n}`, label: `Akun ${n}`, keyHint: `••••${1000 + n}`, source: 'store', state: 'ready', inFlight: 0, uses: n * 3, failures: 0, ...extra });

function fake(initial: { elevenlabs?: PoolKeyView[]; gemini?: PoolKeyView[] } = {}, opts: { addReply?: { status: number; body: unknown }; test?: unknown } = {}) {
  const pools: KeyPools = { elevenlabs: { keys: initial.elevenlabs ?? [], max: 10 }, gemini: { keys: initial.gemini ?? [], max: 10, primary: 'opencode-go' } };
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/providers/keypool' && method === 'GET') return json(200, pools);
    const add = url.match(/^\/api\/providers\/keypool\/(elevenlabs|gemini)$/);
    if (add && method === 'POST') {
      if (opts.addReply) return json(opts.addReply.status, opts.addReply.body);
      const k = key(pools[add[1] as 'elevenlabs'].keys.length + 1, { label: body.label ?? 'Akun baru', keyHint: `••••${String(body.key).slice(-4)}` });
      pools[add[1] as 'elevenlabs'].keys.push(k);
      return json(201, { key: k, verified: true });
    }
    const one = url.match(/^\/api\/providers\/keypool\/(elevenlabs|gemini)\/([^/]+)(\/test)?$/);
    if (one && method === 'DELETE') { const list = pools[one[1] as 'elevenlabs'].keys; list.splice(list.findIndex(k => k.id === one[2]), 1); return json(200, { ok: true }); }
    if (one && one[3] && method === 'POST') return json(200, opts.test ?? { ok: true, tier: 'creator', used: 100, limit: 100000, left: 99900 });
    if (url === '/api/providers/text-routing' && method === 'PUT') { Object.assign(pools.gemini, body); return json(200, body); }
    return json(404, { error: { message: `no fake for ${method} ${url}` } });
  });
  return { fetchImpl, calls, pools };
}
const open = (provider: 'elevenlabs' | 'gemini', f: ReturnType<typeof fake>) => render(
  <SessionContext.Provider value={{ user: admin, fetchImpl: f.fetchImpl, signOut: async () => undefined }}><KeyPoolPanel provider={provider} /></SessionContext.Provider>
);
const secretShown = () => document.body.innerHTML.includes(SECRET) || [...document.querySelectorAll('input')].some(i => i.value === SECRET);

describe('Pengaturan › API key pool', () => {
  it('shows a skeleton while loading and an error with retry when loading fails', async () => {
    const f = fake();
    f.fetchImpl.mockImplementationOnce(async () => json(500, { error: { message: 'server down' } }));
    open('elevenlabs', f);
    expect(screen.getByRole('status', { name: /memuat key elevenlabs/i })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/gagal dimuat/i);
    await userEvent.click(screen.getByRole('button', { name: /coba lagi/i }));
    expect(await screen.findByText(/belum ada key/i)).toBeInTheDocument();
  });

  it('lists keys masked with their state, usage and a count out of 10', async () => {
    open('elevenlabs', fake({ elevenlabs: [key(1), key(2, { state: 'cooldown', reason: 'batas pemakaian (429)', cooldownUntilMs: Date.now() + 40_000 }), key(3, { source: 'env' })] }));
    const list = await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('3/10 key')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Akun 1' })).getByText('••••1001')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Akun 2' })).getByText('Istirahat')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Akun 2' })).getByText(/batas pemakaian.*lanjut/i)).toBeInTheDocument();
    // a key that comes from the server environment cannot be deleted here
    expect(within(screen.getByRole('listitem', { name: 'Akun 3' })).queryByRole('button', { name: /hapus/i })).toBeNull();
    expect(within(screen.getByRole('listitem', { name: 'Akun 1' })).getByRole('button', { name: /hapus/i })).toBeInTheDocument();
  });

  it('adds a key: sends it once, clears the field, never shows it again', async () => {
    const f = fake();
    open('elevenlabs', f);
    await screen.findByText(/belum ada key/i);
    await userEvent.type(screen.getByLabelText('API key'), SECRET);
    await userEvent.type(screen.getByLabelText(/nama/i), 'Utama');
    await userEvent.click(screen.getByRole('button', { name: /tambah key/i }));
    expect(await screen.findByRole('listitem', { name: 'Utama' })).toBeInTheDocument();
    expect(f.calls.filter(c => c.method === 'POST')).toEqual([{ method: 'POST', url: '/api/providers/keypool/elevenlabs', body: { key: SECRET, label: 'Utama' } }]);
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(secretShown()).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent(/terverifikasi/i);
  });

  it('says why a key was refused and keeps the list unchanged', async () => {
    const f = fake({}, { addReply: { status: 400, body: { error: { code: 'INVALID_KEY', message: 'ElevenLabs menolak API key ini. Periksa lagi key-nya.' } } } });
    open('elevenlabs', f);
    await screen.findByText(/belum ada key/i);
    await userEvent.type(screen.getByLabelText('API key'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: /tambah key/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/menolak API key/i);
    expect(screen.queryByRole('list', { name: /key elevenlabs/i })).toBeNull();
  });

  it('at 10 keys the form is disabled with the reason; removing one frees it', async () => {
    const f = fake({ elevenlabs: Array.from({ length: 10 }, (_, i) => key(i + 1)) });
    open('elevenlabs', f);
    await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(screen.getByLabelText('API key')).toBeDisabled();
    expect(screen.getByRole('button', { name: /tambah key/i })).toBeDisabled();
    expect(screen.getByText(/maksimal/i)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Akun 10' })).getByRole('button', { name: /hapus/i }));
    await waitFor(() => expect(screen.getByLabelText('API key')).toBeEnabled());
    expect(screen.getByText('9/10 key')).toBeInTheDocument();
  });

  it('test shows the credits left, or the reason it failed', async () => {
    const f = fake({ elevenlabs: [key(1)] });
    open('elevenlabs', f);
    await userEvent.click(await screen.findByRole('button', { name: /tes key akun 1/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/sisa 99\.900 dari 100\.000 karakter/);
    const bad = fake({ elevenlabs: [key(1)] }, { test: { ok: false, reason: 'ditolak (401)', rejected: true } });
    document.body.innerHTML = '';
    open('elevenlabs', bad);
    await userEvent.click(await screen.findByRole('button', { name: /tes key akun 1/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ditolak \(401\)/);
  });

  it('Gemini: choose which text model goes first and name the Gemini model', async () => {
    const f = fake({ gemini: [key(1)] });
    open('gemini', f);
    await screen.findByRole('list', { name: /key gemini/i });
    await userEvent.click(screen.getByRole('radio', { name: 'Gemini' }));
    await waitFor(() => expect(f.calls.some(c => c.method === 'PUT' && c.body?.primary === 'gemini')).toBe(true));
    await userEvent.type(screen.getByLabelText(/nama model gemini/i), 'gemini-3.6-flash');
    await userEvent.click(screen.getByRole('button', { name: /simpan model/i }));
    await waitFor(() => expect(f.calls.some(c => c.method === 'PUT' && c.body?.geminiModel === 'gemini-3.6-flash')).toBe(true));
  });

  it('the ElevenLabs panel has no model routing controls', async () => {
    open('elevenlabs', fake({ elevenlabs: [key(1)] }));
    await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(screen.queryByLabelText(/nama model gemini/i)).toBeNull();
  });
});

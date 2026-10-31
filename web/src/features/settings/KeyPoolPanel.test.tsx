import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import { KeyPoolPanel } from './KeyPoolPanel.js';
import type { DormantKeyView, KeyPools, PoolKeyView } from './keyPoolClient.js';

const admin: User = { id: 'u1', email: 'joseph@example.com', isAdmin: true };
const SECRET = 'sk_live_super_secret_9999';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const key = (n: number, extra: Partial<PoolKeyView> = {}): PoolKeyView => ({ id: `k${n}`, label: `Akun ${n}`, keyHint: `••••${1000 + n}`, source: 'store', state: 'ready', inFlight: 0, uses: n * 3, failures: 0, ...extra });

const dormantKey = (n: number, extra: Partial<DormantKeyView> = {}): DormantKeyView => ({ id: `d${n}`, label: `Lama ${n}`, keyHint: `••••${2000 + n}`, source: 'store', addedAtMs: 1, reason: 'batas', ...extra });

function fake(initial: { elevenlabs?: PoolKeyView[]; gemini?: PoolKeyView[]; dormant?: DormantKeyView[]; warnings?: string[] } = {}, opts: { addReply?: { status: number; body: unknown }; replaceReply?: { status: number; body: unknown }; test?: unknown } = {}) {
  const pools: KeyPools = { elevenlabs: { keys: initial.elevenlabs ?? [], max: 1, dormant: initial.dormant ?? [], warnings: initial.warnings ?? [] }, gemini: { keys: initial.gemini ?? [], max: 10, primary: 'opencode-go' } };
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/providers/keypool' && method === 'GET') return json(200, pools);
    if (url === '/api/providers/keypool/elevenlabs/active' && method === 'PUT') {
      if (opts.replaceReply) return json(opts.replaceReply.status, opts.replaceReply.body);
      const k = key(9, { label: body.label ?? 'Akun baru', keyHint: `••••${String(body.key).slice(-4)}` });
      pools.elevenlabs.keys = [k];
      return json(200, { key: k, verified: true });
    }
    const activate = url.match(/^\/api\/providers\/keypool\/elevenlabs\/([^/]+)\/activate$/);
    if (activate && method === 'POST') {
      const d = pools.elevenlabs.dormant!.find(x => x.id === activate[1])!;
      pools.elevenlabs.dormant = [...pools.elevenlabs.dormant!.filter(x => x.id !== d.id), ...pools.elevenlabs.keys.map(k => dormantKey(5, { id: k.id, label: k.label }))];
      pools.elevenlabs.keys = [key(7, { id: d.id, label: d.label })];
      return json(200, { ok: true });
    }
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

  it('Gemini lists keys masked with their state, usage and a count out of 10', async () => {
    open('gemini', fake({ gemini: [key(1), key(2, { state: 'cooldown', reason: 'batas pemakaian (429)', cooldownUntilMs: Date.now() + 40_000 }), key(3, { source: 'env' })] }));
    const list = await screen.findByRole('list', { name: /key gemini/i });
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
    expect(screen.getByLabelText('Kunci baru')).toHaveValue(''); // with its one key the form now offers "Ganti kunci"
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

  it('Gemini: at 10 keys the form is disabled with the reason; removing one frees it', async () => {
    const f = fake({ gemini: Array.from({ length: 10 }, (_, i) => key(i + 1)) });
    open('gemini', f);
    await screen.findByRole('list', { name: /key gemini/i });
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

  it('ElevenLabs explains "hanya satu kunci" and shows the 1/1 count', async () => {
    open('elevenlabs', fake({ elevenlabs: [key(1)] }));
    await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(screen.getByText('1/1 key')).toBeInTheDocument();
    expect(screen.getByText(/hanya satu kunci yang dipakai/i)).toBeInTheDocument();
    expect(screen.getByText(/melarang berbagi atau memutar beberapa akun/i)).toBeInTheDocument();
  });

  it('ElevenLabs with its key has "Ganti kunci" and no "Tambah key"; the new key is sent to the replace route and never shown again', async () => {
    const f = fake({ elevenlabs: [key(1, { label: 'Utama' })] });
    open('elevenlabs', f);
    await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(screen.queryByRole('button', { name: /tambah key/i })).toBeNull();
    expect(screen.getByLabelText('Kunci baru')).toHaveAttribute('placeholder');
    await userEvent.type(screen.getByLabelText('Kunci baru'), SECRET);
    await userEvent.type(screen.getByLabelText(/nama/i), 'Pengganti');
    await userEvent.click(screen.getByRole('button', { name: /ganti kunci/i }));
    expect(await screen.findByRole('listitem', { name: 'Pengganti' })).toBeInTheDocument();
    expect(f.calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', url: '/api/providers/keypool/elevenlabs/active', body: { key: SECRET, label: 'Pengganti' } }]);
    expect(screen.getByRole('status')).toHaveTextContent(/kunci diganti dan terverifikasi/i);
    expect(screen.getByLabelText('Kunci baru')).toHaveValue('');
    expect(secretShown()).toBe(false);
  });

  it('a refused replacement says why and keeps the old key on screen', async () => {
    const f = fake({ elevenlabs: [key(1, { label: 'Utama' })] }, { replaceReply: { status: 400, body: { error: { code: 'INVALID_KEY', message: 'ElevenLabs menolak API key ini. Periksa lagi key-nya; kunci yang lama tidak diubah.' } } } });
    open('elevenlabs', f);
    await userEvent.type(await screen.findByLabelText('Kunci baru'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: /ganti kunci/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/kunci yang lama tidak diubah/i);
    expect(screen.getByRole('listitem', { name: 'Utama' })).toBeInTheDocument();
  });

  it('dormant keys are listed as "tidak aktif" (masked), can be made active or deleted, and are not in the active list', async () => {
    const f = fake({ elevenlabs: [key(1, { label: 'Utama' })], dormant: [dormantKey(1), dormantKey(2)] });
    open('elevenlabs', f);
    const inactive = await screen.findByRole('list', { name: 'Kunci tidak aktif' });
    expect(within(inactive).getAllByRole('listitem')).toHaveLength(2);
    expect(within(inactive).getAllByText(/tidak aktif — batas 1 kunci/i)).toHaveLength(2);
    expect(within(inactive).getByText('••••2001')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: /key elevenlabs/i })).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /jadikan aktif lama 2/i }));
    await waitFor(() => expect(f.calls.some(c => c.method === 'POST' && c.url === '/api/providers/keypool/elevenlabs/d2/activate')).toBe(true));
    expect(await screen.findByRole('listitem', { name: 'Lama 2' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/sekarang aktif/i);
    await userEvent.click(screen.getByRole('button', { name: /hapus kunci lama 1/i }));
    await waitFor(() => expect(f.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/elevenlabs/d1'))).toBe(true));
  });

  it('with no active key the form adds the first one; dormant keys can still be made active', async () => {
    const f = fake({ elevenlabs: [], dormant: [dormantKey(1)] });
    open('elevenlabs', f);
    await screen.findByText(/belum ada key/i);
    expect(screen.getByRole('button', { name: /tambah key/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /jadikan aktif lama 1/i })).toBeInTheDocument();
  });

  it('a key that comes from the server is changed there: the replace form is off, with the reason; extra server keys are dormant and cannot be swapped in', async () => {
    const f = fake({ elevenlabs: [key(1, { source: 'env', label: 'Env 1' })], dormant: [dormantKey(1, { source: 'env', label: 'Env 2', reason: 'env' })], warnings: ['Environment server berisi 2 kunci ElevenLabs, tetapi hanya kunci pertama yang dipakai; sisanya tidak aktif.'] });
    open('elevenlabs', f);
    await screen.findByRole('list', { name: /key elevenlabs/i });
    expect(screen.getByLabelText('Kunci baru')).toBeDisabled();
    expect(screen.getByRole('button', { name: /ganti kunci/i })).toBeDisabled();
    expect(screen.getByText(/diatur dari konfigurasi server/i)).toBeInTheDocument();
    expect(screen.getByText(/hanya kunci pertama yang dipakai/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /jadikan aktif/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hapus kunci env 2/i })).toBeNull();
  });
});

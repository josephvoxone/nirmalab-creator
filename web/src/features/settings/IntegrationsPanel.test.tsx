import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { User } from '../../lib/api.js';
import { IntegrationsPanel } from './IntegrationsPanel.js';
import SettingsPage from './SettingsPage.js';

type Reply = { status: number; body: unknown };
type Tok = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
const admin: User = { id: 'u1', email: 'joseph@example.com', isAdmin: true };
const REAL = 'nmcp_live_a1b2c3d4e5f6a7b8c9d0';
const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const laptop: Tok = { id: 'tok_1', name: 'Claude Code di laptop', createdAt: ago(3 * 86_400_000), lastUsedAt: ago(2 * 3_600_000) };
const cursor: Tok = { id: 'tok_2', name: 'Cursor kantor', createdAt: ago(86_400_000), lastUsedAt: null };

function fake(opts: { tokens?: Tok[]; gets?: Reply[]; hang?: boolean; test?: Reply; createGate?: Promise<void>; testGate?: Promise<void>; revoke?: Reply } = {}) {
  let tokens = structuredClone(opts.tokens ?? []);
  const gets = [...(opts.gets ?? [])];
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/mcp/tokens' && method === 'GET') {
      if (opts.hang) return new Promise<Response>(() => undefined);
      return json(gets.shift() ?? { status: 200, body: tokens });
    }
    if (url === '/api/mcp/tokens' && method === 'POST') {
      await opts.createGate;
      const t = { id: `tok_${tokens.length + 10}`, name: body.name, createdAt: new Date().toISOString(), lastUsedAt: null };
      tokens = [...tokens, t];
      return json({ status: 201, body: { id: t.id, name: t.name, token: REAL } });
    }
    const del = /^\/api\/mcp\/tokens\/(.+)$/.exec(url);
    if (del && method === 'DELETE') {
      if (opts.revoke) return json(opts.revoke);
      tokens = tokens.filter(t => t.id !== del[1]);
      return json({ status: 200, body: { ok: true } });
    }
    if (url === '/api/mcp/test' && method === 'POST') await opts.testGate;
    if (url === '/api/mcp/test' && method === 'POST') return json(opts.test ?? { status: 200, body: { ok: true, tools: 22, user: admin.email } });
    return json({ status: 404, body: { error: { message: `no fake for ${method} ${url}` } } });
  });
  return { fetchImpl, calls };
}

const open = (f: ReturnType<typeof fake>) => render(
  <SessionContext.Provider value={{ user: admin, fetchImpl: f.fetchImpl, signOut: async () => undefined }}>
    <IntegrationsPanel />
  </SessionContext.Provider>
);
const tokensRegion = () => screen.getByRole('region', { name: /token mcp/i });
const setupRegion = () => screen.getByRole('region', { name: /pasang di klien/i });
const code = () => within(setupRegion()).getByLabelText(/^konfigurasi/i);
const noNative = () => expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);

afterEach(() => vi.restoreAllMocks());

describe('Pengaturan › Integrasi', () => {
  it('says what MCP is for in one line and shows a labelled skeleton while loading', () => {
    open(fake({ hang: true }));
    expect(screen.getByText('Hubungkan Claude, Cursor, OpenCode atau Codex ke proyekmu lewat MCP. Asisten di luar app memakai aksi yang sama dengan chat proyek — biaya tetap butuh persetujuanmu.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /memuat token/i })).toBeInTheDocument();
  });

  it('lists tokens with created and last-used times', async () => {
    open(fake({ tokens: [laptop, cursor] }));
    const row = await within(tokensRegion()).findByRole('listitem', { name: 'Claude Code di laptop' });
    expect(row).toHaveTextContent('Dibuat 3 hari lalu');
    expect(row).toHaveTextContent('Terakhir dipakai 2 jam lalu');
    expect(within(tokensRegion()).getByRole('listitem', { name: 'Cursor kantor' })).toHaveTextContent('Terakhir dipakai Belum pernah');
    noNative();
  });

  it('empty state says why and offers Buat token', async () => {
    const user = userEvent.setup();
    open(fake());
    expect(await within(tokensRegion()).findByText('Belum ada token')).toBeInTheDocument();
    expect(within(tokensRegion()).getByText(/klien mcp masuk sebagai kamu/i)).toBeInTheDocument();
    await user.click(within(tokensRegion()).getByRole('button', { name: 'Buat token' }));
    expect(within(tokensRegion()).getByLabelText('Nama token')).toHaveAttribute('placeholder', 'mis. Claude Code di laptop');
  });

  it('a failed load explains it and Coba lagi reloads', async () => {
    const user = userEvent.setup();
    open(fake({ gets: [{ status: 500, body: { error: { message: 'disk penuh' } } }], tokens: [laptop] }));
    const alert = await within(tokensRegion()).findByRole('alert');
    expect(alert).toHaveTextContent(/token gagal dimuat/i);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(tokensRegion()).findByRole('listitem', { name: 'Claude Code di laptop' })).toBeInTheDocument();
  });

  it('creates a token, shows it once with the real token in the snippet, Selesai removes it for good', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const f = fake();
    open(f);
    expect(code()).toHaveTextContent('<TOKEN>');
    await user.click(await within(tokensRegion()).findByRole('button', { name: 'Buat token' }));
    const name = within(tokensRegion()).getByLabelText('Nama token');
    expect(within(tokensRegion()).getByRole('button', { name: /^buat$/i })).toBeDisabled();
    await user.type(name, 'Claude Code di laptop');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));

    const reveal = await screen.findByRole('region', { name: /token baru/i });
    expect(f.calls.find(c => c.method === 'POST' && c.url === '/api/mcp/tokens')?.body).toEqual({ name: 'Claude Code di laptop' });
    expect(reveal).toHaveTextContent(REAL);
    expect(reveal).toHaveTextContent('Token ini hanya ditampilkan sekali. Simpan sekarang.');
    await user.click(within(reveal).getByRole('button', { name: /salin/i }));
    expect(writeText).toHaveBeenCalledWith(REAL);
    expect(code()).toHaveTextContent(`Authorization: Bearer ${REAL}`);
    expect(code()).not.toHaveTextContent('<TOKEN>');
    expect(await within(tokensRegion()).findByRole('listitem', { name: 'Claude Code di laptop' })).toBeInTheDocument();

    await user.click(within(reveal).getByRole('button', { name: 'Selesai' }));
    expect(screen.queryByRole('region', { name: /token baru/i })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(REAL);
    expect(code()).toHaveTextContent('<TOKEN>');
    expect(setItem.mock.calls.some(args => args.some(a => String(a).includes(REAL)))).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('Salin falls back to a temporary selection when the Clipboard API is missing', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    open(fake());
    await within(tokensRegion()).findByText('Belum ada token');
    await user.click(within(setupRegion()).getByRole('button', { name: /salin/i }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(await within(setupRegion()).findByRole('button', { name: /tersalin/i })).toBeInTheDocument();
    noNative();
  });

  it('client picker switches steps, file and docs link', async () => {
    const user = userEvent.setup();
    open(fake());
    const picker = within(setupRegion()).getByRole('radiogroup', { name: /klien/i });
    expect(within(picker).getAllByRole('radio').map(r => r.textContent)).toEqual(['Claude Code', 'Claude Desktop', 'Cursor', 'OpenCode', 'Codex']);
    expect(code()).toHaveTextContent('claude mcp add --transport http shotweave');
    expect(code()).toHaveTextContent(`${window.location.origin}/mcp`);
    // Long commands wrap instead of scrolling sideways (clipped at 390 and 1440 in the walk).
    expect(code()).toHaveClass('whitespace-pre-wrap', 'break-all');
    expect(code()).not.toHaveClass('whitespace-pre');
    await user.click(within(picker).getByRole('radio', { name: 'Claude Desktop' }));
    expect(code()).toHaveTextContent('mcp-remote');
    expect(setupRegion()).toHaveTextContent(/Node\.js 18/);
    expect(setupRegion()).toHaveTextContent('claude_desktop_config.json');
    await user.click(within(picker).getByRole('radio', { name: 'Codex' }));
    expect(code()).toHaveTextContent('bearer_token_env_var');
    expect(within(setupRegion()).getByLabelText(/variabel token/i, { selector: 'pre' })).toHaveTextContent('export NIRMALAB_MCP_TOKEN="<TOKEN>"');
    expect(within(setupRegion()).getByRole('link', { name: /dokumentasi resmi/i })).toHaveAttribute('href', 'https://developers.openai.com/codex/mcp/');
    expect(within(setupRegion()).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
  });

  it('Cabut asks first with the token name, then calls DELETE', async () => {
    const user = userEvent.setup();
    const f = fake({ tokens: [laptop, cursor] });
    open(f);
    const row = await within(tokensRegion()).findByRole('listitem', { name: 'Cursor kantor' });
    await user.click(within(row).getByRole('button', { name: /cabut/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Cabut token Cursor kantor?');
    expect(dialog).toHaveTextContent('Klien yang memakainya langsung terputus.');
    expect(f.calls.some(c => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: /^cabut/i }));
    await waitFor(() => expect(f.calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/api/mcp/tokens/tok_2']));
    await waitFor(() => expect(within(tokensRegion()).queryByRole('listitem', { name: 'Cursor kantor' })).not.toBeInTheDocument());
    expect(within(tokensRegion()).getByRole('listitem', { name: 'Claude Code di laptop' })).toBeInTheDocument();
  });

  it('at 10 tokens Buat token is disabled with a hint', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...cursor, id: `tok_${i}`, name: `Token ${i}` }));
    open(fake({ tokens: ten }));
    await within(tokensRegion()).findByRole('listitem', { name: 'Token 9' });
    expect(within(tokensRegion()).getByRole('button', { name: 'Buat token' })).toBeDisabled();
    expect(tokensRegion()).toHaveTextContent('Maksimal 10 token');
  });

  it('Tes koneksi shows the tool count, with the revealed token when there is one', async () => {
    const user = userEvent.setup();
    const f = fake();
    open(f);
    await within(tokensRegion()).findByText('Belum ada token');
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    expect(await within(setupRegion()).findByRole('status')).toHaveTextContent('Terhubung · 22 tools');
    expect(f.calls.filter(c => c.url === '/api/mcp/test').map(c => c.body)).toEqual([{}]);

    await user.click(within(tokensRegion()).getByRole('button', { name: 'Buat token' }));
    await user.type(within(tokensRegion()).getByLabelText('Nama token'), 'Codex');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));
    await screen.findByRole('region', { name: /token baru/i });
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    await waitFor(() => expect(f.calls.filter(c => c.url === '/api/mcp/test').map(c => c.body)).toEqual([{}, { token: REAL }]));
  });

  it('Tes koneksi failing shows the plain error', async () => {
    const user = userEvent.setup();
    open(fake({ test: { status: 503, body: { error: { code: 'FAILED', message: 'Server MCP tidak menjawab — coba lagi' } } } }));
    await within(tokensRegion()).findByText('Belum ada token');
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    expect(await within(setupRegion()).findByRole('alert')).toHaveTextContent(/tes gagal.*server mcp tidak menjawab/i);
  });
});

describe('Pengaturan › Integrasi — review fixes', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

  it('create and test have their own busy state: one finishing never re-enables the other mid-request', async () => {
    const user = userEvent.setup();
    const create = gate();
    const test = gate();
    open(fake({ tokens: [laptop], createGate: create.p, testGate: test.p }));
    await user.click(await within(tokensRegion()).findByRole('button', { name: 'Buat token' }));
    await user.type(within(tokensRegion()).getByLabelText('Nama token'), 'Codex');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));
    const making = within(tokensRegion()).getByRole('button', { name: 'Membuat…' });
    expect(making).toBeDisabled();
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    expect(within(setupRegion()).getByRole('button', { name: /mengetes/i })).toBeDisabled();
    // The test starting does not re-enable "Buat" while the create request is still out.
    expect(within(tokensRegion()).getByRole('button', { name: 'Membuat…' })).toBeDisabled();
    test.open();
    expect(await within(setupRegion()).findByRole('status')).toHaveTextContent('Terhubung · 22 tools');
    expect(within(tokensRegion()).getByRole('button', { name: 'Membuat…' })).toBeDisabled();
    // And the other way round: a test still out stays "Mengetes…" while a create finishes.
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    create.open();
    expect(await screen.findByRole('region', { name: /token baru/i })).toBeInTheDocument();
  });

  it('a create finishing does not re-enable Tes koneksi while a test is still out', async () => {
    const user = userEvent.setup();
    const create = gate();
    const test = gate();
    open(fake({ createGate: create.p, testGate: test.p }));
    await user.click(await within(tokensRegion()).findByRole('button', { name: 'Buat token' }));
    await user.type(within(tokensRegion()).getByLabelText('Nama token'), 'Codex');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));
    await user.click(within(setupRegion()).getByRole('button', { name: /tes koneksi/i }));
    create.open();
    await screen.findByRole('region', { name: /token baru/i });
    expect(within(setupRegion()).getByRole('button', { name: /mengetes/i })).toBeDisabled();
    test.open();
    await waitFor(() => expect(within(setupRegion()).getByRole('button', { name: /tes koneksi/i })).toBeEnabled());
  });

  it('a malformed token list is an error with Coba lagi, not an empty list', async () => {
    const user = userEvent.setup();
    open(fake({ gets: [{ status: 200, body: { tokens: 'rusak' } }], tokens: [laptop] }));
    const alert = await within(tokensRegion()).findByRole('alert');
    expect(alert).toHaveTextContent(/token gagal dimuat/i);
    expect(within(tokensRegion()).queryByText('Belum ada token')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    expect(await within(tokensRegion()).findByRole('listitem', { name: 'Claude Code di laptop' })).toBeInTheDocument();
  });

  it('Codex has two copy buttons with distinct names', async () => {
    const user = userEvent.setup();
    open(fake());
    await user.click(within(within(setupRegion()).getByRole('radiogroup', { name: /klien/i })).getByRole('radio', { name: 'Codex' }));
    expect(within(setupRegion()).getByRole('button', { name: 'Salin konfigurasi' })).toBeInTheDocument();
    expect(within(setupRegion()).getByRole('button', { name: 'Salin variabel token' })).toBeInTheDocument();
  });

  it('cancelling or reopening the form clears a create or revoke error', async () => {
    const user = userEvent.setup();
    const f = fake({ tokens: [laptop], revoke: { status: 500, body: { error: { message: 'disk penuh' } } } });
    open(f);
    const row = await within(tokensRegion()).findByRole('listitem', { name: 'Claude Code di laptop' });
    await user.click(within(row).getByRole('button', { name: /cabut/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^cabut/i }));
    expect(await within(tokensRegion()).findByRole('alert')).toHaveTextContent(/disk penuh/);
    await user.click(within(tokensRegion()).getByRole('button', { name: 'Buat token' }));
    expect(within(tokensRegion()).queryByRole('alert')).toBeNull();
    // A create error, then Batal: gone too.
    f.fetchImpl.mockImplementationOnce(async () => json({ status: 409, body: { error: { message: 'Maksimal 10 token' } } }));
    await user.type(within(tokensRegion()).getByLabelText('Nama token'), 'Satu lagi');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));
    expect(await within(tokensRegion()).findByRole('alert')).toHaveTextContent(/maksimal 10 token/i);
    await user.click(within(tokensRegion()).getByRole('button', { name: /^batal$/i }));
    expect(within(tokensRegion()).queryByRole('alert')).toBeNull();
  });

  it('revoking the token that is still revealed clears the reveal and the snippet goes back to <TOKEN>', async () => {
    const user = userEvent.setup();
    open(fake());
    await user.click(await within(tokensRegion()).findByRole('button', { name: 'Buat token' }));
    await user.type(within(tokensRegion()).getByLabelText('Nama token'), 'Laptop');
    await user.click(within(tokensRegion()).getByRole('button', { name: /^buat$/i }));
    await screen.findByRole('region', { name: /token baru/i });
    expect(code()).toHaveTextContent(REAL);
    const row = await within(tokensRegion()).findByRole('listitem', { name: 'Laptop' });
    await user.click(within(row).getByRole('button', { name: /cabut/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^cabut/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /token baru/i })).toBeNull());
    expect(code()).toHaveTextContent('<TOKEN>');
    expect(document.body.innerHTML).not.toContain(REAL);
  });
});

describe('Pengaturan tab Integrasi', () => {
  const renderSettings = (user: User, f = fake()) => render(
    <SessionContext.Provider value={{ user, fetchImpl: f.fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab="integrasi" /></MemoryRouter>
    </SessionContext.Provider>
  );

  it('admins get the Integrasi tab and its panel', async () => {
    renderSettings(admin);
    expect(screen.getByRole('tab', { name: 'Integrasi' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: /token mcp/i })).toBeInTheDocument();
  });

  it('a non-admin does not see the tab and loads no tokens', async () => {
    const f = fake();
    renderSettings({ ...admin, isAdmin: false }, f);
    expect(screen.queryByRole('tab', { name: 'Integrasi' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Umum' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: /token mcp/i })).not.toBeInTheDocument();
    await new Promise(r => setTimeout(r, 20));
    expect(f.calls.filter(c => c.url.startsWith('/api/mcp'))).toEqual([]);
  });
});

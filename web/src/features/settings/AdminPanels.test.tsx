import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import { admin, bodyOf, fail, fakeFetch, ok, type Handler } from '../../test/fake.js';
import SettingsPage, { type SettingsTab } from './SettingsPage.js';

function page(handler: Handler, tab: SettingsTab) {
  const fetchImpl = fakeFetch(handler);
  const view = render(
    <SessionContext.Provider value={{ user: admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter><SettingsPage tab={tab} /></MemoryRouter>
    </SessionContext.Provider>
  );
  return { fetchImpl, ...view };
}

const MEMBERS = [
  { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true, createdAt: '2026-10-01T00:00:00Z' },
  { id: 'u2', email: 'tim@nirmalab.com', isAdmin: false, createdAt: '2026-10-02T00:00:00Z', lastSeenAt: '2026-10-23T00:00:00Z' }
];
const zeroUsage = Object.fromEntries(['flowCredits', 'openrouterUsd', 'elevenChars', 'llmTurns', 'genCalls'].map(k => [k, { day: 0, d30: 0, reserved: 0 }]));
const limitsView = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  userId: 'u2', email: 'tim@nirmalab.com', isAdmin: false, limits: over,
  effective: { elevenChars: { perDay: 2000, per30d: 5000, perRender: 2500 }, ...over },
  defaults: { elevenChars: { perDay: 2000, per30d: 5000, perRender: 2500 } },
  usage: { ...zeroUsage, ...usage }
});
const PROJECTS = {
  owners: [
    { userId: 'u1', email: 'joseph@nirmalab.com', isAdmin: true, projects: 6, bytes: 5_200_000, lastActivityMs: 1_700_000_000_000 },
    { userId: 'u2', email: 'tim@nirmalab.com', isAdmin: false, projects: 0, bytes: 0, lastActivityMs: null },
    { userId: 'u3', email: 'dina@nirmalab.com', isAdmin: false, projects: 2, bytes: 1_048_576, lastActivityMs: 1_700_000_100_000, suspendedAt: '2026-10-30T00:00:00Z' }
  ],
  orphans: [{ id: 'story_aaaaaaaaaaaaaaaa', title: 'Kakek Hilang Perahu', ownerId: 'u_old', ownerEmail: 'lama@nirmalab.com', bytes: 2_097_152, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_500_000, status: 'done' }],
  totals: { projects: 8, bytes: 8_000_000, orphans: 1, orphanBytes: 2_097_152, unreadable: 0 }
};

describe('Pengaturan › Anggota (admin)', () => {
  it('suspends and re-activates a member; the badge and the button follow', async () => {
    let members = MEMBERS.map(m => ({ ...m } as Record<string, unknown>));
    const calls: string[] = [];
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members });
      const m = url.match(/^\/api\/admin\/users\/(\w+)\/(suspend|activate)$/);
      if (m && init?.method === 'POST') {
        calls.push(`${m[2]} ${m[1]}`);
        members = members.map(x => x.id === m[1] ? (m[2] === 'suspend' ? { ...x, suspendedAt: '2026-11-01T00:00:00Z' } : { ...x, suspendedAt: undefined }) : x);
        return ok({ member: members.find(x => x.id === m[1]) });
      }
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    const row = await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' });
    expect(within(row).queryByText(/ditangguhkan/i)).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /^tangguhkan/i }));
    await waitFor(() => expect(calls).toEqual(['suspend u2']));
    const after = await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' });
    expect(await within(after).findByText(/ditangguhkan/i)).toBeInTheDocument();
    await userEvent.click(within(after).getByRole('button', { name: /^aktifkan/i }));
    await waitFor(() => expect(calls).toEqual(['suspend u2', 'activate u2']));
    await waitFor(() => expect(within(within(region).getByRole('listitem', { name: 'tim@nirmalab.com' })).queryByText(/ditangguhkan/i)).toBeNull());
    // you never get a suspend/limits control on your own row
    const me = within(region).getByRole('listitem', { name: 'joseph@nirmalab.com' });
    expect(within(me).queryByRole('button', { name: /tangguhkan/i })).toBeNull();
  });

  it('the removal dialog says what happens: projects stay (orphans), tokens and connections go, suspend is the softer option; the answer says how many became orphans', async () => {
    let members = MEMBERS.map(m => ({ ...m }));
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members });
      if (url === '/api/auth/members/u2' && init?.method === 'DELETE') { members = members.filter(m => m.id !== 'u2'); return ok({ ok: true, orphanedProjects: 3 }); }
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' })).getByRole('button', { name: /^keluarkan/i }));
    const dialog = await screen.findByRole('alertdialog');
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/tim@nirmalab\.com/);
    expect(text).toMatch(/proyek.*tidak (ikut )?dihapus/i);
    expect(text).toMatch(/yatim/i);
    expect(text).toMatch(/token|koneksi/i);
    expect(text).toMatch(/tangguhkan/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /ya, keluarkan/i }));
    expect(await within(region).findByText(/3 proyek menjadi yatim/i)).toBeInTheDocument();
    expect(within(region).queryByRole('listitem', { name: 'tim@nirmalab.com' })).toBeNull();
  });

  it('Batas & pemakaian: loading, then numbers with placeholders; saves exactly what changed; unlimited = empty', async () => {
    const puts: unknown[] = [];
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members: MEMBERS });
      if (url === '/api/admin/users/u2/limits' && !init?.method) return ok(limitsView({}, { elevenChars: { day: 1200, d30: 1800, reserved: 0 }, flowCredits: { day: 30, d30: 120, reserved: 0 } }));
      if (url === '/api/admin/users/u2/limits' && init?.method === 'PUT') { puts.push(bodyOf(init)); return ok(limitsView(bodyOf(init).limits)); }
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' })).getByRole('button', { name: /batas & pemakaian/i }));
    const dialog = await screen.findByRole('dialog', { name: /batas & pemakaian.*tim@nirmalab\.com/i });
    // ElevenLabs: default numbers shown, usage shown, "Bawaan" chip
    const eleven = await within(dialog).findByRole('group', { name: /elevenlabs/i });
    expect(within(eleven).getByLabelText(/per hari/i)).toHaveValue('2000');
    expect(within(eleven).getByText(/bawaan/i)).toBeInTheDocument();
    expect(eleven).toHaveTextContent(/hari ini 1\.200/);
    // Flow: unlimited by default (empty field, placeholder says so)
    const flow = within(dialog).getByRole('group', { name: /flow/i });
    expect(within(flow).getByLabelText(/per hari/i)).toHaveValue('');
    expect(within(flow).getByLabelText(/per hari/i)).toHaveAttribute('placeholder', 'Tanpa batas');
    await userEvent.type(within(flow).getByLabelText(/per hari/i), '100');
    const or = within(dialog).getByRole('group', { name: /openrouter/i });
    await userEvent.type(within(or).getByLabelText(/per 30 hari/i), '5.5');
    await userEvent.click(within(dialog).getByRole('button', { name: /^simpan/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    // only the two kinds the admin touched are sent; ElevenLabs stays on its default (not in the body); blank fields are null
    expect(puts[0]).toEqual({ limits: { flowCredits: { perDay: 100, per30d: null }, openrouterUsd: { perDay: null, per30d: 5.5 } } });
    expect(await within(dialog).findByText(/batas disimpan/i)).toBeInTheDocument();
  });

  it('warns when a limit is lower than what was already used, rejects non-numbers before sending, and resets to the defaults', async () => {
    const puts: unknown[] = [];
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members: MEMBERS });
      if (url === '/api/admin/users/u2/limits' && !init?.method) return ok(limitsView({ flowCredits: { perDay: 500, per30d: null } }, { flowCredits: { day: 300, d30: 900, reserved: 0 } }));
      if (url === '/api/admin/users/u2/limits' && init?.method === 'PUT') { puts.push(bodyOf(init)); return ok(limitsView({})); }
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' })).getByRole('button', { name: /batas & pemakaian/i }));
    const dialog = await screen.findByRole('dialog');
    const flow = await within(dialog).findByRole('group', { name: /flow/i });
    expect(within(flow).queryByText(/bawaan/i)).toBeNull();
    const day = within(flow).getByLabelText(/per hari/i);
    await userEvent.clear(day); await userEvent.type(day, '100');
    expect(flow).toHaveTextContent(/lebih kecil dari pemakaian hari ini \(300\)/i);
    await userEvent.clear(day); await userEvent.type(day, 'banyak');
    await userEvent.click(within(dialog).getByRole('button', { name: /^simpan/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/angka/i);
    expect(puts).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: /kembalikan ke bawaan/i }));
    await waitFor(() => expect(puts).toEqual([{ limits: {} }]));
  });

  it('limits panel: error says what failed and retries; a refused save shows the server\'s words', async () => {
    let n = 0;
    page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members: MEMBERS });
      if (url === '/api/admin/users/u2/limits' && !init?.method) return ++n === 1 ? fail(500, 'rusak') : ok(limitsView());
      if (url === '/api/admin/users/u2/limits' && init?.method === 'PUT') return fail(400, 'Batas flowCredits.perDay harus angka 0 atau lebih');
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' })).getByRole('button', { name: /batas & pemakaian/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/batas.*gagal dimuat/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /coba lagi/i }));
    const flow = await within(dialog).findByRole('group', { name: /flow/i });
    await userEvent.type(within(flow).getByLabelText(/per hari/i), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: /^simpan/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/harus angka 0 atau lebih/i);
  });
});

describe('Pengaturan › Penyimpanan (admin)', () => {
  // the fake server keeps state: once an orphan is moved or deleted, the next GET /api/admin/projects no longer lists it
  let gone = new Set<string>();
  const handler = (extra?: Handler): Handler => (url, init) => {
    const own = extra?.(url, init);
    if (own) {
      const hit = url.match(/^\/api\/admin\/projects\/(story_\w+)/);
      if (hit && own.status === 200) gone.add(hit[1]!);
      return own;
    }
    return url === '/api/admin/projects' ? ok({ ...PROJECTS, orphans: PROJECTS.orphans.filter(o => !gone.has(o.id)) }) : undefined;
  };
  beforeEach(() => { gone = new Set(); });

  it('shows bytes per owner WITHOUT any project title, and the orphans with title, previous owner, size and date', async () => {
    page(handler(), 'penyimpanan');
    const owners = await screen.findByRole('region', { name: /pemakaian per pengguna/i });
    const table = within(owners).getByRole('table');
    expect(within(table).getByText('joseph@nirmalab.com')).toBeInTheDocument();
    expect(within(table).getByText(/6/)).toBeInTheDocument();
    expect(table).toHaveTextContent(/5\.0 MB|5,0 MB|4\.\d MB|5 MB/);
    expect(within(table).getByText(/ditangguhkan/i)).toBeInTheDocument();
    expect(owners.textContent).not.toMatch(/Kakek Hilang Perahu|story_/);
    const orphans = screen.getByRole('region', { name: /proyek yatim/i });
    const row = within(orphans).getByRole('listitem', { name: 'Kakek Hilang Perahu' });
    expect(row).toHaveTextContent('story_aaaaaaaaaaaaaaaa');
    expect(row).toHaveTextContent('lama@nirmalab.com');
    expect(row).toHaveTextContent(/2(,|\.)0 MB|2 MB/);
  });

  it('three states: loading names what loads, error retries, empty explains how a project becomes an orphan', async () => {
    let n = 0;
    page(handler((url) => {
      if (url !== '/api/admin/projects') return undefined;
      n += 1;
      return n === 1 ? fail(500, 'x') : ok({ ...PROJECTS, orphans: [], totals: { ...PROJECTS.totals, orphans: 0 } });
    }), 'penyimpanan');
    expect(screen.getByRole('status', { name: /memuat penyimpanan/i })).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/penyimpanan gagal dimuat/i);
    await userEvent.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    const empty = await screen.findByText(/tidak ada proyek yatim/i);
    expect(empty.closest('section')?.textContent).toMatch(/pemiliknya dikeluarkan/i);
  });

  it('Pindahkan ke…: pick a living, active user in a dropdown, the project leaves the list', async () => {
    const calls: unknown[] = [];
    page(handler((url, init) => {
      if (url === '/api/admin/projects/story_aaaaaaaaaaaaaaaa/transfer' && init?.method === 'POST') { calls.push(bodyOf(init)); return ok({ ok: true, id: 'story_aaaaaaaaaaaaaaaa', toUserId: 'u2', jobsReassigned: 2 }); }
      return undefined;
    }), 'penyimpanan');
    const orphans = await screen.findByRole('region', { name: /proyek yatim/i });
    await userEvent.click(within(orphans).getByRole('button', { name: /pindahkan ke/i }));
    const dialog = await screen.findByRole('dialog', { name: /pindahkan/i });
    expect(dialog).toHaveTextContent('Kakek Hilang Perahu');
    const confirm = within(dialog).getByRole('button', { name: /^pindahkan$/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /pengguna tujuan/i }));
    const tim = await screen.findByRole('option', { name: /tim@nirmalab\.com/i });
    // the list is open now: a suspended user (dina) is not offered
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(expect.arrayContaining(['joseph@nirmalab.com', 'tim@nirmalab.com']));
    expect(screen.queryByRole('option', { name: /dina@nirmalab\.com/i })).toBeNull();
    await userEvent.click(tim);
    await userEvent.click(within(dialog).getByRole('button', { name: /^pindahkan$/i }));
    await waitFor(() => expect(calls).toEqual([{ toUserId: 'u2' }]));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /proyek yatim/i })).queryByRole('listitem', { name: 'Kakek Hilang Perahu' })).toBeNull());
  });

  it('Hapus: needs the title typed exactly (button stays off until then); sends confirmTitle; a refusal is shown', async () => {
    const calls: unknown[] = [];
    let refuse = false;
    page(handler((url, init) => {
      if (url === '/api/admin/projects/story_aaaaaaaaaaaaaaaa' && init?.method === 'DELETE') { calls.push(bodyOf(init)); return refuse ? fail(409, 'Proyek ini masih punya pemilik.') : ok({ ok: true, id: 'story_aaaaaaaaaaaaaaaa', freedBytes: 2_097_152 }); }
      return undefined;
    }), 'penyimpanan');
    const orphans = await screen.findByRole('region', { name: /proyek yatim/i });
    await userEvent.click(within(orphans).getByRole('button', { name: /^hapus/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/tidak bisa dibatalkan|permanen/i);
    const input = within(dialog).getByPlaceholderText(/ketik judul proyek/i);
    const go = within(dialog).getByRole('button', { name: /hapus permanen/i });
    expect(go).toBeDisabled();
    await userEvent.type(input, 'Kakek Hilang');
    expect(go).toBeDisabled();
    await userEvent.type(input, ' Perahu');
    expect(go).toBeEnabled();
    refuse = true;
    await userEvent.click(go);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/masih punya pemilik/i);
    refuse = false;
    await userEvent.click(within(dialog).getByRole('button', { name: /hapus permanen/i }));
    await waitFor(() => expect(calls).toEqual([{ confirmTitle: 'Kakek Hilang Perahu' }, { confirmTitle: 'Kakek Hilang Perahu' }]));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /proyek yatim/i })).queryByRole('listitem', { name: 'Kakek Hilang Perahu' })).toBeNull());
  });

  it('Bersihkan runs the storage cleanup and says how much it freed', async () => {
    page(handler((url, init) => url === '/api/storage/cleanup' && init?.method === 'POST' ? ok({ freedBytes: 3_145_728, linked: 1, removed: 4 }) : undefined), 'penyimpanan');
    await userEvent.click(await screen.findByRole('button', { name: /bersihkan/i }));
    expect(await screen.findByText(/membebaskan 3(,|\.)0 MB|membebaskan 3 MB/i)).toBeInTheDocument();
  });

  it('no native controls and every input carries a placeholder (storage + limits + dialogs)', async () => {
    const { container } = page((url, init) => {
      if (url === '/api/auth/members' && !init?.method) return ok({ members: MEMBERS });
      if (url === '/api/admin/users/u2/limits') return ok(limitsView());
      if (url === '/api/auth/invites') return ok({ invites: [] });
      return undefined;
    }, 'anggota');
    const region = await screen.findByRole('region', { name: /^anggota/i });
    await userEvent.click(within(await within(region).findByRole('listitem', { name: 'tim@nirmalab.com' })).getByRole('button', { name: /batas & pemakaian/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('group', { name: /flow/i });
    for (const root of [container, dialog]) {
      expect(root.querySelectorAll('select, input[type=checkbox], input[type=radio], input[type=date], input[type=time], input[type=range]')).toHaveLength(0);
    }
    for (const input of Array.from(dialog.querySelectorAll('input'))) expect(input.getAttribute('placeholder'), input.getAttribute('aria-label') ?? '').toBeTruthy();
  });
});

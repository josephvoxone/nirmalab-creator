import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import type { Board } from './model.js';
import { bibleBoard, compileRoute, fakeProjectApi, ID, mountProject, storyFor, type Call, type ExtraRoute } from './testkit.js';
import type { Story } from '../stories/storiesClient.js';

type Api = ReturnType<typeof fakeProjectApi>;
const scenePanel = () => screen.getByRole('region', { name: /^Scene / });
const breakdowns = (api: Api) => api.calls.filter(c => c.url.includes('/breakdown'));

/** Breakdown like the server: `count` new intent shots appended to (or replacing) the scene. */
function breakdownRoute(holder: { api?: Api }, opts: { error?: { status: number; code: string; message: string }; gate?: Promise<void> } = {}): ExtraRoute {
  return async (call: Call, json) => {
    const m = new RegExp(`^/api/stories/${ID}/scenes/([^/]+)/breakdown$`).exec(call.url);
    if (!m || call.method !== 'POST') return compileRoute(call, json);
    await opts.gate;
    if (opts.error) return json(opts.error.status, { error: { code: opts.error.code, message: opts.error.message } });
    const api = holder.api!;
    const count = Number(call.body?.count);
    const fresh = Array.from({ length: count }, (_, i) => ({
      id: `ai-${i + 1}`, prompt: `Medium shot, the camera stays still. JINGGA beat ${i + 1}.`, narration: `Jingga langkah ${i + 1}.`,
      intent: { subject: 'JINGGA', action: `beat ${i + 1}`, startState: 'a', endState: 'b' }
    }));
    const scene = api.board.scenes!.find(s => s.id === m[1])!;
    const drop = call.body?.mode === 'replace' ? new Set(scene.shots) : new Set<string>();
    const board: Board = {
      ...api.board,
      shots: [...api.board.shots.filter(s => !drop.has(s.id)), ...fresh],
      scenes: api.board.scenes!.map(s => (s.id === scene.id ? { ...s, shots: [...s.shots.filter(id => !drop.has(id)), ...fresh.map(f => f.id)] } : s))
    };
    api.board = board;
    api.story = { ...api.story, rev: (api.story.rev ?? 1) + 1, shots: [...api.story.shots.filter(s => !drop.has(s.id)), ...fresh.map(f => ({ id: f.id, status: 'pending', attempts: 0 }))] } as Story;
    return json(200, { label: `Scene dipecah jadi ${count} shot`, changed: true, undoId: 'u_1', story: api.story, storyboard: board });
  };
}

function setup(board: Board, opts: Parameters<typeof breakdownRoute>[1] = {}) {
  const holder: { api?: Api } = {};
  holder.api = fakeProjectApi({ board, story: storyFor(board, [], [], { rev: 2 }), extra: breakdownRoute(holder, opts) });
  return holder.api;
}

async function openDialog() {
  await screen.findByRole('list', { name: /daftar scene/i });
  await userEvent.click(within(scenePanel()).getByRole('button', { name: 'Aksi scene' }));
  await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /pecah jadi shot \(ai\)/i }));
  return screen.findByRole('dialog', { name: /pecah/i });
}

describe('Scene board — "Pecah jadi shot (AI)"', () => {
  it('posts {count, brief, mode} from the dialog (mentions in Arahan) and refreshes the board', async () => {
    const api = setup(bibleBoard());
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    const dialog = await openDialog();
    const count = within(dialog).getByRole('radiogroup', { name: 'Jumlah shot' });
    expect(within(count).getByRole('radio', { name: '4' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(count).getByRole('radio', { name: '3' }));
    const brief = within(dialog).getByRole('combobox', { name: 'Arahan' });
    expect(brief).toHaveAttribute('placeholder', 'mis. buka dengan close-up tangan @LARAS, akhiri di pintu');
    await userEvent.type(brief, 'buka dengan @Ji');
    // Escape closes only the mention list, never the dialog around it.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: /pecah/i })).toBeInTheDocument();
    await userEvent.type(brief, 'n');
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: /jingga/i })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await userEvent.type(brief, 'menoleh ke jalan');
    // The scene already has real shots: replacing would delete them, so it adds at the end.
    const mode = within(dialog).getByRole('radiogroup', { name: 'Mode' });
    expect(within(mode).getByRole('radio', { name: 'Ganti shot kosong' })).toBeDisabled();
    expect(within(mode).getByRole('radio', { name: 'Tambah di akhir' })).toHaveAttribute('aria-checked', 'true');
    const gets = api.calls.filter(c => c.method === 'GET' && c.url === `/api/stories/${ID}`).length;
    await userEvent.click(within(dialog).getByRole('button', { name: /pecah jadi 3 shot/i }));
    await waitFor(() => expect(breakdowns(api)).toHaveLength(1));
    expect(breakdowns(api)[0]!.url).toBe(`/api/stories/${ID}/scenes/menunggu/breakdown`);
    expect(breakdowns(api)[0]!.body).toEqual({ count: 3, brief: 'buka dengan JINGGA menoleh ke jalan', mode: 'append' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /pecah/i })).toBeNull());
    const grid = within(scenePanel()).getByRole('list', { name: /shot di scene/i });
    await waitFor(() => expect(within(grid).getAllByRole('listitem')).toHaveLength(5));
    await waitFor(() => expect(api.calls.filter(c => c.method === 'GET' && c.url === `/api/stories/${ID}`).length).toBeGreaterThan(gets));
  });

  it('defaults to "Ganti shot kosong" when the scene only has empty shots, and shows N skeleton rows while the AI works', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const base = bibleBoard();
    const board: Board = {
      ...base,
      shots: [...base.shots.filter(s => s.id !== '00-pembuka' && s.id !== '01-pagar'), { id: 'shot-5', prompt: 'Medium shot, the camera stays still. ', narration: 'Tulis narasi singkat di sini.', intent: { subject: 'JINGGA', action: '', startState: '', endState: '' } }],
      scenes: [{ ...base.scenes![0]!, shots: ['shot-5'] }, base.scenes![1]!]
    };
    const api = setup(board, { gate });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    const dialog = await openDialog();
    expect(within(within(dialog).getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: 'Ganti shot kosong' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: /pecah jadi 4 shot/i }));
    const progress = await within(dialog).findByRole('status', { name: 'AI sedang memecah scene…' });
    expect(progress.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(breakdowns(api)[0]!.body).toEqual({ count: 4, mode: 'replace' });
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /pecah/i })).toBeNull());
  });

  it('without a text model it says what to set up and links to Pengaturan › Provider', async () => {
    const api = setup(bibleBoard(), { error: { status: 503, code: 'UNAVAILABLE', message: 'Model teks belum diatur — isi key di Pengaturan › Provider › Model teks.' } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: /pecah jadi 4 shot/i }));
    expect(await within(dialog).findByText('Butuh model teks — atur di Pengaturan › Provider')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /buka pengaturan/i })).toHaveAttribute('href', '/pengaturan/provider');
  });

  it('a failed breakdown shows the plain reason and "Coba lagi" sends it again', async () => {
    const api = setup(bibleBoard(), { error: { status: 400, code: 'INVALID', message: 'Scene "Menunggu" belum punya tujuan di bible.' } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: /pecah jadi 4 shot/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Scene "Menunggu" belum punya tujuan di bible.');
    await userEvent.click(within(dialog).getByRole('button', { name: /coba lagi/i }));
    await waitFor(() => expect(breakdowns(api)).toHaveLength(2));
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });

  it('is not offered on legacy boards (no dead button)', async () => {
    const api = fakeProjectApi();
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await screen.findByRole('list', { name: /daftar scene/i });
    await userEvent.click(within(scenePanel()).getByRole('button', { name: 'Aksi scene' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /pecah jadi shot/i })).toBeNull();
  });
});

describe('Scene board — new shot on a bible board', () => {
  it('"Tambah shot" creates an intent skeleton (first character as subject) and opens its sheet', async () => {
    const api = fakeProjectApi({ board: bibleBoard(), extra: compileRoute });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await screen.findByRole('list', { name: /daftar scene/i });
    await userEvent.click(within(scenePanel()).getByRole('button', { name: 'Tambah shot' }));
    await waitFor(() => expect(api.calls.some(c => c.method === 'PUT')).toBe(true));
    const sent = api.calls.filter(c => c.method === 'PUT').at(-1)!.body!.storyboard as Board;
    const added = sent.shots.find(s => !bibleBoard().shots.some(o => o.id === s.id))!;
    expect(added.intent).toEqual({ subject: 'JINGGA', action: '', startState: '', endState: '' });
    const sheet = await screen.findByRole('dialog', { name: new RegExp(`· ${added.id}$`) });
    expect(within(sheet).getByRole('combobox', { name: 'Subjek' })).toHaveValue('JINGGA');
    expect(within(sheet).queryByRole('textbox', { name: /prompt \(english\)/i })).toBeNull();
  });
});

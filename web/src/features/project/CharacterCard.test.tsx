import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BreakdownTab } from './BreakdownTab.js';
import { ProjectPage } from './ProjectPage.js';
import { ProjectProvider, useProjectState } from './useProject.js';
import { BIBLE, bibleBoard, fakeProjectApi, ID, mountProject, storyFor, type ExtraRoute } from './testkit.js';
import type { Board } from './model.js';
import type { Story } from '../stories/storiesClient.js';

type Api = ReturnType<typeof fakeProjectApi>;
const UPLOAD = { id: 'up_0123456789abcdef', url: `/api/stories/${ID}/uploads/up_0123456789abcdef.png`, w: 800, h: 1200, bytes: 2048 };

/** Sheet + upload routes like the server: Flow sheet jobs are free, the click is the confirm. */
const routes = (state: { story?: () => Story; setStory?: (s: Story) => void }): ExtraRoute => (call, json) => {
  const sheet = new RegExp(`^/api/stories/${ID}/cast/([A-Z_]+)/sheet$`).exec(call.url);
  if (sheet && call.method === 'POST') {
    if (call.body?.confirm !== true) return json(200, { needsConfirm: true, label: `Buat sheet ${sheet[1]}`, estimate: { usd: 0.04 } });
    const s = state.story!();
    const next = { ...s, status: 'casting', cast: (s.cast ?? []).map(c => (c.token === sheet[1] ? { ...c, status: 'queued' } : c)) } as Story;
    state.setStory!(next);
    return json(200, { label: `Sheet ${sheet[1]} dibuat`, story: next });
  }
  if (call.url === `/api/stories/${ID}/uploads` && call.method === 'POST') return json(201, UPLOAD);
  return undefined;
};

function setup(over: { board?: Board; story?: Story } = {}) {
  const board = over.board ?? bibleBoard();
  const holder: { api?: Api } = {};
  const api = fakeProjectApi({
    board, story: over.story ?? storyFor(board),
    extra: routes({ story: () => holder.api!.story, setStory: s => { holder.api!.story = s; } })
  });
  holder.api = api;
  return api;
}

async function open(api: Api) {
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
  const cast = await screen.findByRole('region', { name: /^karakter$/i });
  return cast;
}
const lastBoard = (api: Api) => api.calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as Record<string, any> | undefined;
const card = (cast: HTMLElement, name: string) => within(cast).getByRole('listitem', { name });

describe('Breakdown › character cards (bible boards)', () => {
  it('shows name, TOKEN, anchors, want/need/arc and a bounded sheet thumbnail with its status', async () => {
    const cast = await open(setup());
    const jingga = card(cast, 'Jingga');
    expect(within(jingga).getByText('JINGGA')).toBeInTheDocument();
    expect(within(within(jingga).getByRole('list', { name: 'Anchor Jingga' })).getAllByRole('listitem').map(li => li.textContent)).toEqual(['bulu oranye belang', 'kalung kulit merah pudar']);
    expect(jingga).toHaveTextContent('menunggu pemiliknya');
    expect(jingga).toHaveTextContent('berani pergi');
    expect(jingga).toHaveTextContent('dari diam jadi bergerak');
    const img = within(jingga).getByRole('img', { name: 'Sheet Jingga' });
    expect(img.getAttribute('src')).toMatch(/\/cast\/JINGGA\/image\?w=160$/);
    expect(Number(img.getAttribute('width'))).toBeLessThanOrEqual(120);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(jingga).toHaveTextContent('Siap');
    expect(within(jingga).getByRole('button', { name: /buat ulang sheet · gratis/i })).toBeInTheDocument();
    // Flow engine (default): the reference is for OpenRouter only, and the card says so.
    expect(cast).toHaveTextContent('Referensi dipakai mesin OpenRouter; Flow memakai sheet yang dibuat.');
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });

  it('"Buat sheet" calls the sheet route for that character only (Flow: free, the click confirms)', async () => {
    const board = bibleBoard();
    const story = storyFor(board, [], [], { cast: [{ token: 'JINGGA', name: 'Jingga', status: 'done', attempts: 0 }, { token: 'BIMA', name: 'Bima', status: 'pending', attempts: 0 }] });
    const api = setup({ board, story });
    const cast = await open(api);
    const bima = card(cast, 'Bima');
    expect(bima).toHaveTextContent('Belum dibuat');
    expect(within(bima).queryByRole('img', { name: 'Sheet Bima' })).toBeNull();
    await userEvent.click(within(bima).getByRole('button', { name: /^buat sheet · gratis$/i }));
    await waitFor(() => expect(api.calls.filter(c => c.url.includes('/sheet'))).toHaveLength(1));
    const call = api.calls.find(c => c.url.includes('/sheet'))!;
    expect(call.url).toBe(`/api/stories/${ID}/cast/BIMA/sheet`);
    expect(call.body).toEqual({ confirm: true });
    await waitFor(() => expect(card(screen.getByRole('region', { name: /^karakter$/i }), 'Bima')).toHaveTextContent('Membuat…'));
  });

  it('on OpenRouter "Buat sheet" asks first with the price, then runs on Jalankan', async () => {
    const board = { ...bibleBoard(), engine: { image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' } } } as Board;
    const story = storyFor(board, [], [], { cast: [{ token: 'JINGGA', name: 'Jingga', status: 'done', attempts: 0 }, { token: 'BIMA', name: 'Bima', status: 'pending', attempts: 0 }] });
    const api = setup({ board, story });
    const cast = await open(api);
    const bima = card(cast, 'Bima');
    expect(cast).not.toHaveTextContent('Flow memakai sheet');
    await userEvent.click(within(bima).getByRole('button', { name: /^buat sheet$/i }));
    expect(await within(bima).findByText(/±\$0,04/)).toBeInTheDocument();
    expect(api.calls.filter(c => c.url.includes('/sheet')).map(c => c.body)).toEqual([{}]);
    await userEvent.click(within(bima).getByRole('button', { name: /jalankan/i }));
    await waitFor(() => expect(api.calls.filter(c => c.url.includes('/sheet')).map(c => c.body)).toEqual([{}, { confirm: true }]));
  });

  it('uploads a reference as a raw image body, stores it on the card, shows it, and removes it', async () => {
    const api = setup();
    const cast = await open(api);
    const jingga = card(cast, 'Jingga');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'jingga.png', { type: 'image/png' });
    // The file input is not a second control next to the button: hidden from the page and from assistive tech.
    expect(within(jingga).getByLabelText('Pilih gambar referensi Jingga')).not.toBeVisible();
    expect(within(jingga).getAllByRole('button', { name: /referensi/i })).toHaveLength(1);
    await userEvent.upload(within(jingga).getByLabelText('Pilih gambar referensi Jingga'), file);
    await waitFor(() => expect(api.calls.some(c => c.url === `/api/stories/${ID}/uploads`)).toBe(true));
    const post = api.calls.find(c => c.url === `/api/stories/${ID}/uploads`)!;
    expect(post.method).toBe('POST');
    expect(post.raw).toBe(file);
    expect(post.headers?.['Content-Type']).toBe('image/png');
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[0]?.reference).toBe('uploads/up_0123456789abcdef.png'));
    const ref = await within(card(screen.getByRole('region', { name: /^karakter$/i }), 'Jingga')).findByRole('img', { name: 'Referensi Jingga' });
    // A sized webp of the upload (64 px at 1x, 96 px at 2x), not the 800×1200 original.
    expect(ref).toHaveAttribute('src', `${UPLOAD.url}?w=64`);
    expect(ref).toHaveAttribute('srcset', `${UPLOAD.url}?w=64 1x, ${UPLOAD.url}?w=96 2x`);
    expect(Number(ref.getAttribute('width'))).toBeLessThanOrEqual(120);
    await userEvent.click(within(card(screen.getByRole('region', { name: /^karakter$/i }), 'Jingga')).getByRole('button', { name: /hapus referensi/i }));
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[0]).not.toHaveProperty('reference'));
  });

  it('rejects an 11 MB file before sending anything, with a plain message', async () => {
    const api = setup();
    const cast = await open(api);
    const jingga = card(cast, 'Jingga');
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'besar.png', { type: 'image/png' });
    await userEvent.upload(within(jingga).getByLabelText('Pilih gambar referensi Jingga'), big);
    expect(await within(jingga).findByText('Gambar terlalu besar — maksimal 10 MB.')).toBeInTheDocument();
    expect(api.calls.some(c => c.url.endsWith('/uploads'))).toBe(false);
  });

  it('warns with real counts before saving an anchor change, then saves the bible card', async () => {
    const board = bibleBoard();
    // JINGGA is in shots 01 and 03; both clips are done.
    const api = setup({ board, story: storyFor(board, [], ['pending', 'done', 'pending', 'done']) });
    const cast = await open(api);
    const jingga = card(cast, 'Jingga');
    await userEvent.click(within(jingga).getByRole('button', { name: 'Ubah Jingga' }));
    const warning = 'Mengubah tampilan membuat ulang sheet + keyframe 2 shot (gratis di Flow) dan klip 2 shot (±20 kredit)';
    expect(within(jingga).queryByText(warning)).toBeNull();
    // want/need/arc edits never touch the look: no warning.
    const want = within(jingga).getByRole('textbox', { name: 'Want' });
    await userEvent.clear(want);
    await userEvent.type(want, 'menunggu di pagar');
    expect(within(jingga).queryByText(warning)).toBeNull();
    await userEvent.click(within(jingga).getByRole('button', { name: 'Hapus anchor kalung kulit merah pudar' }));
    await userEvent.type(within(jingga).getByRole('textbox', { name: 'Anchor baru Jingga' }), 'kalung merah bertali emas{Enter}');
    expect(within(jingga).getByText(warning)).toBeInTheDocument();
    expect(api.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    await userEvent.click(within(jingga).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[0]).toMatchObject({
      token: 'JINGGA', name: 'Jingga', anchors: ['bulu oranye belang', 'kalung merah bertali emas'], want: 'menunggu di pagar'
    }));
    // Everything else in the bible survives the save.
    expect(lastBoard(api)?.bible?.locations).toEqual(BIBLE.locations);
    expect(lastBoard(api)?.bible?.characters?.[1]).toEqual(BIBLE.characters[1]);
  });

  it('a new character is written on both sides (bible card + cast entry); its sheet waits until a shot uses it', async () => {
    const api = setup();
    const cast = await open(api);
    await userEvent.click(within(cast).getByRole('button', { name: /tambah karakter/i }));
    await userEvent.type(within(cast).getByRole('textbox', { name: 'Nama karakter' }), 'Bu Sari');
    await userEvent.type(within(cast).getByRole('textbox', { name: 'Anchor visual baru' }), 'kebaya hijau lumut, sanggul kecil');
    await userEvent.click(within(cast).getByRole('button', { name: /^tambah$/i }));
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[2]).toEqual({ token: 'BU_SARI', name: 'Bu Sari', anchors: ['kebaya hijau lumut', 'sanggul kecil'], want: '', need: '', arc: '' }));
    expect(lastBoard(api)?.characters?.BU_SARI).toBe('Bu Sari, kebaya hijau lumut, sanggul kecil');
    // The server makes a sheet only for a character some shot uses: the card says so instead of a dead button.
    const sari = await within(screen.getByRole('region', { name: /^karakter$/i })).findByRole('listitem', { name: 'Bu Sari' });
    expect(within(sari).queryByRole('button', { name: /buat (ulang )?sheet/i })).toBeNull();
    expect(sari).toHaveTextContent('Sheet bisa dibuat setelah Bu Sari dipakai di shot (sebut BU_SARI di subjek atau aksi).');
  });

  it('legacy boards keep the {name, look} editor (no anchors, no sheet button)', async () => {
    const cast = await open(fakeProjectApi());
    const jingga = card(cast, 'Jingga');
    expect(within(jingga).queryByRole('list', { name: /anchor/i })).toBeNull();
    expect(within(jingga).queryByRole('button', { name: /buat (ulang )?sheet/i })).toBeNull();
    expect(jingga).toHaveTextContent(/orange tabby/);
  });
});

describe('Breakdown › location cards (bible boards)', () => {
  it('shows the key and the bible lookdev, and saves an edit on both sides', async () => {
    const api = setup();
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
    const locs = await screen.findByRole('region', { name: /^lokasi$/i });
    const pagar = within(locs).getByRole('listitem', { name: 'Pagar rumah' });
    expect(pagar).toHaveTextContent('PAGAR');
    expect(pagar).toHaveTextContent('a weathered wooden gate in a quiet village at dusk');
    await userEvent.click(within(pagar).getByRole('button', { name: 'Ubah Pagar rumah' }));
    const look = within(pagar).getByRole('textbox', { name: /deskripsi visual/i });
    await userEvent.clear(look);
    await userEvent.type(look, 'a blue iron gate under a mango tree at dusk');
    await userEvent.click(within(pagar).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(lastBoard(api)?.bible?.locations?.[0]).toEqual({ key: 'PAGAR', name: 'Pagar rumah', lookdev: 'a blue iron gate under a mango tree at dusk' }));
    expect(lastBoard(api)?.locations?.PAGAR).toEqual({ name: 'Pagar rumah', look: 'a blue iron gate under a mango tree at dusk' });
  });
});

describe('Breakdown › reference upload vs. the assistant', () => {
  it('an assistant edit + reload while the upload is pending survives the save that stores the reference', async () => {
    const board = bibleBoard();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const holder: { api?: Api } = {};
    const api = fakeProjectApi({
      board, story: storyFor(board, [], [], { rev: 2 }),
      extra: async (call, json) => {
        if (call.url === `/api/stories/${ID}/uploads` && call.method === 'POST') { await held; return json(201, UPLOAD); }
        return undefined;
      }
    });
    holder.api = api;
    let project!: ReturnType<typeof useProjectState>;
    function Page() {
      const { id = '' } = useParams();
      const p = useProjectState(id, 0);
      project = p;
      if (!p.board || !p.story) return <p>memuat</p>;
      return <ProjectProvider value={p}><BreakdownTab /></ProjectProvider>;
    }
    mountProject(<Page />, api.fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
    const cast = await screen.findByRole('region', { name: /^karakter$/i });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'jingga.png', { type: 'image/png' });
    await userEvent.upload(within(card(cast, 'Jingga')).getByLabelText('Pilih gambar referensi Jingga'), file);
    await waitFor(() => expect(api.calls.some(c => c.url === `/api/stories/${ID}/uploads`)).toBe(true));
    // While the image uploads, the assistant renames the project; the chat panel reloads the tab.
    api.board = { ...api.board, title: 'Judul dari asisten' };
    api.story = { ...api.story, title: 'Judul dari asisten', rev: 3 };
    act(() => project.reload());
    await waitFor(() => expect(project.board!.title).toBe('Judul dari asisten'));
    release();
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[0]?.reference).toBe('uploads/up_0123456789abcdef.png'));
    expect(lastBoard(api)?.title).toBe('Judul dari asisten');
    expect(api.board.title).toBe('Judul dari asisten');
    expect(api.board.bible).toMatchObject({ characters: [{ token: 'JINGGA', reference: 'uploads/up_0123456789abcdef.png' }, BIBLE.characters[1]] });
  });
});

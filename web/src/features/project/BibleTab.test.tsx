import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import type { StoryBible } from '../bible/story.js';

const BIBLE: StoryBible = {
  logline: 'Seekor kucing oranye menunggu pemiliknya pulang setiap sore.',
  theme: 'Kesetiaan yang tidak dihitung', tone: 'Hangat, sedikit sedih', audience: 'umum',
  structure: [
    { act: 'hook', goal: 'Jingga duduk sendirian di pagar saat truk pindah pergi' },
    { act: 'setup', goal: 'Rutinitas menunggu setiap sore' },
    { act: 'turn', goal: 'Hujan turun dan pagar akhirnya kosong' },
    { act: 'payoff', goal: 'Bima turun dari mobil dan memanggil namanya' }
  ],
  characters: [{
    token: 'JINGGA', name: 'Jingga', anchors: ['bulu oranye belang', 'kalung kulit merah pudar'],
    want: 'menunggu pemiliknya kembali', need: 'berani mengikuti orang baru', arc: 'dari menunggu pasif jadi berani bergerak'
  }],
  scenes: [{ id: 'menunggu', title: 'Menunggu', goal: 'Menunjukkan kesetiaan Jingga di pagar' }]
};

const withBible = () => ({ ...BOARD, bible: BIBLE });
const open = async (api = fakeProjectApi({ board: withBible() })) => {
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=bible` });
  await screen.findByRole('region', { name: /^cerita$/i });
  return api;
};
type Api = ReturnType<typeof fakeProjectApi>;
const lastBoard = (api: Api) => api.calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as Record<string, any> | undefined;

describe('Bible tab', () => {
  it('shows logline, tema, tone, the four acts with a goal each, characters and scene goals', async () => {
    await open();
    const story = screen.getByRole('region', { name: /^cerita$/i });
    expect(story).toHaveTextContent(/menunggu pemiliknya pulang setiap sore/i);
    expect(story).toHaveTextContent(/kesetiaan yang tidak dihitung/i);
    expect(story).toHaveTextContent(/hangat, sedikit sedih/i);

    const acts = within(screen.getByRole('region', { name: /^struktur$/i })).getAllByRole('listitem');
    expect(acts.map(li => li.getAttribute('aria-label'))).toEqual(['Hook', 'Setup', 'Turn', 'Payoff']);
    expect(acts[0]).toHaveTextContent(/truk pindah pergi/i);
    expect(acts[3]).toHaveTextContent(/memanggil namanya/i);

    // Characters have one editor (Breakdown); the bible only points there.
    const cast = screen.getByRole('region', { name: /^karakter$/i });
    expect(within(cast).queryByRole('listitem')).toBeNull();
    expect(cast).toHaveTextContent(/1 karakter/);

    const scenes = within(screen.getByRole('region', { name: /tujuan scene/i })).getAllByRole('listitem');
    expect(scenes[0]).toHaveTextContent(/Menunggu/);
    expect(scenes[0]).toHaveTextContent(/kesetiaan Jingga di pagar/i);
    // Scene kedua belum punya tujuan di bible — tetap tampil, dengan ajakan mengisi.
    expect(scenes[1]).toHaveTextContent(/belum ada tujuan/i);
  });

  it('says what a bible is and offers "Buat bible" instead of an empty editor', async () => {
    const api = fakeProjectApi({ board: BOARD });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=bible` });
    expect(await screen.findByText(/belum punya bible/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^struktur$/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /buat bible/i }));
    await waitFor(() => expect(lastBoard(api)?.bible).toBeTruthy());
    const bible = lastBoard(api)!.bible as StoryBible;
    expect(bible.structure.map(a => a.act)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    expect(bible.logline).toBe(BOARD.logline);
    expect(bible.characters.map(c => c.token).sort()).toEqual(['BIMA', 'JINGGA']);
    expect(bible.scenes.map(s => s.id)).toEqual(['menunggu', 'pulang']);
    expect(lastBoard(api)!.shots).toHaveLength(BOARD.shots.length);
    expect(await screen.findByRole('region', { name: /^struktur$/i })).toBeInTheDocument();
  });

  it('has no character editor: "Kelola karakter di Breakdown" switches to the Breakdown tab', async () => {
    await open();
    const cast = screen.getByRole('region', { name: /^karakter$/i });
    expect(within(cast).queryByRole('button', { name: /anchor/i })).toBeNull();
    await userEvent.click(within(cast).getByRole('link', { name: 'Kelola karakter di Breakdown' }));
    expect(await screen.findByRole('tab', { name: /breakdown/i, selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Jingga' })).toHaveTextContent('JINGGA');
  });

  it('an edit keeps every bible field this tab does not show (locations, references, scene locations)', async () => {
    const full = {
      ...BIBLE,
      characters: [{ ...BIBLE.characters[0]!, reference: 'uploads/up_0123456789abcdef.png', sheet: 'm1' }],
      locations: [{ key: 'PAGAR', name: 'Pagar rumah', lookdev: 'a weathered wooden gate' }],
      scenes: [{ ...BIBLE.scenes[0]!, location: 'PAGAR', stateIn: 'sendiri' }]
    };
    const api = fakeProjectApi({ board: { ...BOARD, bible: full } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=bible` });
    const story = await screen.findByRole('region', { name: /^cerita$/i });
    await userEvent.click(within(story).getByRole('button', { name: /ubah tema/i }));
    await userEvent.type(within(story).getByRole('textbox', { name: /^tema$/i }), ' dan pulang{Enter}');
    await waitFor(() => expect(lastBoard(api)?.bible?.theme).toMatch(/dan pulang$/));
    const sent = lastBoard(api)!.bible;
    expect(sent.characters).toEqual(full.characters);
    expect(sent.locations).toEqual(full.locations);
    expect(sent.scenes[0]).toEqual(full.scenes[0]);
  });

  it('edits the goal of one act and the goal of one scene', async () => {
    const api = await open();
    const structure = screen.getByRole('region', { name: /^struktur$/i });
    await userEvent.click(within(structure).getByRole('button', { name: /ubah tujuan hook/i }));
    const goal = within(structure).getByRole('textbox', { name: /tujuan hook/i });
    await userEvent.clear(goal);
    await userEvent.type(goal, 'Kucing ditinggal di depan pagar{Enter}');
    await waitFor(() => expect(lastBoard(api)?.bible?.structure?.[0]?.goal).toBe('Kucing ditinggal di depan pagar'));

    const scenes = screen.getByRole('region', { name: /tujuan scene/i });
    await userEvent.click(within(scenes).getByRole('button', { name: /ubah tujuan menunggu/i }));
    await userEvent.type(within(scenes).getByRole('textbox', { name: /tujuan menunggu/i }), 'Rutinitas sore yang sabar{Enter}');
    await waitFor(() => expect(lastBoard(api)?.bible?.scenes?.find((s: { id: string }) => s.id === 'menunggu')?.goal)
      .toMatch(/rutinitas sore yang sabar/i));
  });

  it('warns in Indonesian about slots that are still empty, without blocking the save', async () => {
    const partial: StoryBible = { ...BIBLE, logline: '', characters: [{ ...BIBLE.characters[0]!, want: '', anchors: ['indah menawan'] }] };
    const api = fakeProjectApi({ board: { ...BOARD, bible: partial } });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=bible` });
    const warn = await screen.findByRole('status', { name: /slot belum lengkap/i });
    expect(warn).toHaveTextContent(/logline/i);
    expect(warn).toHaveTextContent(/want/i);
    expect(warn).toHaveTextContent(/kata rasa/i);
    // Warn, do not block: an edit still saves (the spec allows a draft bible).
    const story = screen.getByRole('region', { name: /^cerita$/i });
    await userEvent.click(within(story).getByRole('button', { name: /ubah tema/i }));
    await userEvent.type(within(story).getByRole('textbox', { name: /^tema$/i }), ' dan kehilangan{Enter}');
    await waitFor(() => expect(lastBoard(api)?.bible?.theme).toMatch(/kehilangan/i));
  });

  it("shows the server's Indonesian validation message when the save is refused", async () => {
    const api = fakeProjectApi({
      board: withBible(),
      fail: { put: { status: 400, message: 'Anchor JINGGA hanya berisi kata rasa; tulis fakta yang bisa dilihat' } }
    });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=bible` });
    const story = await screen.findByRole('region', { name: /^cerita$/i });
    await userEvent.click(within(story).getByRole('button', { name: /ubah tema/i }));
    await userEvent.type(within(story).getByRole('textbox', { name: /^tema$/i }), ' dan kehilangan{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/anchor jingga hanya berisi kata rasa/i);
  });

  it('a STALE refusal keeps the typed text open until the user saves it again (on the fresh board) or cancels', async () => {
    const api = fakeProjectApi({ board: withBible(), story: storyFor(withBible(), [], [], { rev: 4 }) });
    await open(api);
    // The assistant changes the logline before this tab saves its theme.
    api.board = { ...api.board, bible: { ...BIBLE, logline: 'Logline dari asisten' } };
    api.story = { ...api.story, rev: 5 };
    const story = screen.getByRole('region', { name: /^cerita$/i });
    await userEvent.click(within(story).getByRole('button', { name: /ubah tema/i }));
    const theme = within(story).getByRole('textbox', { name: /^tema$/i });
    await userEvent.clear(theme);
    await userEvent.type(theme, 'Kesetiaan yang sabar{Enter}');
    expect(await screen.findByText('Proyek baru diubah di tempat lain — dimuat ulang')).toBeInTheDocument();
    await waitFor(() => expect(within(story).getByText('Logline dari asisten')).toBeInTheDocument());
    // Still there after the fresh board arrived, with a note.
    expect(within(story).getByRole('textbox', { name: /^tema$/i })).toHaveValue('Kesetiaan yang sabar');
    expect(within(story).getByText('Perubahanmu belum tersimpan — simpan lagi')).toBeInTheDocument();
    await userEvent.click(within(story).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(lastBoard(api)?.bible?.theme).toBe('Kesetiaan yang sabar'));
    expect(api.calls.filter(c => c.method === 'PUT').map(c => c.body!.rev)).toEqual([4, 5]);
    expect(api.board.bible).toMatchObject({ theme: 'Kesetiaan yang sabar', logline: 'Logline dari asisten' });
    await waitFor(() => expect(within(story).queryByText('Perubahanmu belum tersimpan — simpan lagi')).toBeNull());
  });

  it('Batal after a STALE refusal drops the held text', async () => {
    const api = fakeProjectApi({ board: withBible(), story: storyFor(withBible(), [], [], { rev: 4 }) });
    await open(api);
    api.story = { ...api.story, rev: 5 };
    const story = screen.getByRole('region', { name: /^cerita$/i });
    await userEvent.click(within(story).getByRole('button', { name: /ubah tone/i }));
    await userEvent.type(within(story).getByRole('textbox', { name: /^tone$/i }), ' sekali{Enter}');
    expect(await within(story).findByText('Perubahanmu belum tersimpan — simpan lagi')).toBeInTheDocument();
    await userEvent.click(within(story).getByRole('button', { name: /^batal$/i }));
    expect(within(story).queryByRole('textbox', { name: /^tone$/i })).toBeNull();
    expect(within(story).getByText(BIBLE.tone)).toBeInTheDocument();
    expect(api.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('uses no native select, date, radio or checkbox', async () => {
    await open();
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });
});

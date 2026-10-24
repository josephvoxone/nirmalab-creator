import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject } from './testkit.js';
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

    const cast = screen.getByRole('region', { name: /^karakter$/i });
    const jingga = within(cast).getByRole('listitem', { name: 'Jingga' });
    expect(jingga).toHaveTextContent(/bulu oranye belang/);
    expect(jingga).toHaveTextContent(/kalung kulit merah pudar/);
    expect(jingga).toHaveTextContent(/menunggu pemiliknya kembali/);
    expect(jingga).toHaveTextContent(/berani mengikuti orang baru/);
    expect(jingga).toHaveTextContent(/berani bergerak/i);

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

  it('edits an anchor inline and saves the whole board with the new anchor', async () => {
    const api = await open();
    const cast = screen.getByRole('region', { name: /^karakter$/i });
    await userEvent.click(within(cast).getByRole('button', { name: /ubah anchor 2/i }));
    const field = within(cast).getByRole('textbox', { name: /anchor 2/i });
    await userEvent.clear(field);
    await userEvent.type(field, 'kalung kulit merah pudar bertali emas{Enter}');
    await waitFor(() => expect(lastBoard(api)?.bible?.characters?.[0]?.anchors)
      .toEqual(['bulu oranye belang', 'kalung kulit merah pudar bertali emas']));
    expect(lastBoard(api)!.shots).toHaveLength(BOARD.shots.length);
    expect(lastBoard(api)!.title).toBe(BOARD.title);
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

  it('uses no native select, date, radio or checkbox', async () => {
    await open();
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });
});

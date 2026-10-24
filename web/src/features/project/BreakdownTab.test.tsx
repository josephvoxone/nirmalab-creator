import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import { CONFIGURED, UNCONFIGURED, providerResponse } from '../providers/fixtures.js';
import type { Providers } from '../providers/providersClient.js';

const open = async (api = fakeProjectApi()) => {
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
  await screen.findByRole('region', { name: /karakter/i });
  return api;
};
const lastBoard = (api: ReturnType<typeof fakeProjectApi>) => api.calls.filter(c => c.method === 'PUT').at(-1)?.body?.storyboard as Record<string, any>;

describe('Breakdown tab', () => {
  it('lists characters with their sheet, look and where they appear', async () => {
    await open();
    const cast = screen.getByRole('region', { name: /karakter/i });
    const jingga = within(cast).getByRole('listitem', { name: 'Jingga' });
    expect(jingga.querySelector('img')?.getAttribute('src')).toMatch(/\/cast\/JINGGA\/image\?(v=[^&]*&)?w=160$/);
    expect(jingga).toHaveTextContent(/orange tabby/);
    expect(jingga).toHaveTextContent(/2 shot · Menunggu, Pulang/);
    expect(within(cast).getByRole('listitem', { name: 'Bima' })).toHaveTextContent(/1 scene|2 shot/);
  });

  it('edits a character look and saves it as {name, look}', async () => {
    const api = await open();
    const jingga = within(screen.getByRole('region', { name: /karakter/i })).getByRole('listitem', { name: 'Jingga' });
    await userEvent.click(within(jingga).getByRole('button', { name: /ubah jingga/i }));
    const look = within(jingga).getByRole('textbox', { name: /deskripsi visual/i });
    await userEvent.clear(look);
    await userEvent.type(look, 'an orange tabby cat with a bright red collar');
    await userEvent.click(within(jingga).getByRole('button', { name: /simpan/i }));
    await waitFor(() => expect(lastBoard(api)?.characters?.JINGGA).toEqual({ name: 'Jingga', look: 'an orange tabby cat with a bright red collar' }));
  });

  it('adds a character with an UPPERCASE token and refuses to delete one used in shots', async () => {
    const api = await open();
    const cast = screen.getByRole('region', { name: /karakter/i });
    await userEvent.click(within(cast).getByRole('button', { name: /tambah karakter/i }));
    await userEvent.type(within(cast).getByRole('textbox', { name: /nama karakter/i }), 'Bu Sari');
    await userEvent.type(within(cast).getByRole('textbox', { name: /deskripsi visual baru/i }), 'a woman in her fifties in a batik apron');
    await userEvent.click(within(cast).getByRole('button', { name: /^tambah$/i }));
    await waitFor(() => expect(lastBoard(api)?.characters?.BU_SARI).toEqual({ name: 'Bu Sari', look: 'a woman in her fifties in a batik apron' }));
    const jingga = within(cast).getByRole('listitem', { name: 'Jingga' });
    expect(within(jingga).getByRole('button', { name: /hapus jingga/i })).toBeDisabled();
  });

  it('manages locations and assigns them to scenes', async () => {
    const api = await open();
    const locs = screen.getByRole('region', { name: /lokasi/i });
    expect(within(locs).getByRole('listitem', { name: 'Pagar rumah' })).toHaveTextContent(/Menunggu/);
    await userEvent.click(within(locs).getByRole('button', { name: /tambah lokasi/i }));
    await userEvent.type(within(locs).getByRole('textbox', { name: /nama lokasi/i }), 'Pasar Ikan');
    await userEvent.type(within(locs).getByRole('textbox', { name: /deskripsi visual baru/i }), 'a wet fish market at dawn');
    await userEvent.click(within(locs).getByRole('button', { name: /^tambah$/i }));
    await waitFor(() => expect(lastBoard(api)?.locations?.PASAR_IKAN).toEqual({ name: 'Pasar Ikan', look: 'a wet fish market at dawn' }));
    const jalan = within(locs).getByRole('listitem', { name: 'Jalan desa' });
    await userEvent.click(within(jalan).getByRole('button', { name: /hapus jalan desa/i }));
    await userEvent.click(await screen.findByRole('button', { name: /ya, hapus/i }));
    await waitFor(() => {
      const b = lastBoard(api);
      expect(b?.locations?.JALAN).toBeUndefined();
      expect(b?.scenes?.find((s: { id: string }) => s.id === 'pulang')?.location).toBeUndefined();
    });
  });

  it('shows the look (style chips) and explains what an edit re-draws', async () => {
    await open();
    const style = screen.getByRole('region', { name: /gaya visual/i });
    expect(await within(style).findByRole('button', { name: /Palet warna/ })).toBeInTheDocument();
    expect(screen.getByText(/dibuat ulang/i)).toBeInTheDocument();
  });

  it('a look chip posts only the changed pick', async () => {
    const api = await open();
    await userEvent.click(await screen.findByRole('button', { name: /Palet warna.*Senja Dongeng/ }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Noir Monokrom/ }));
    await waitFor(() => expect(api.calls.find(c => c.url.endsWith('/look'))?.body).toEqual({ look: { palette: 'noir' } }));
  });
});

describe('Breakdown tab · Mesin produksi', () => {
  type Api = ReturnType<typeof fakeProjectApi>;
  const mount = async (api: Api = fakeProjectApi(), providers: Providers | null = CONFIGURED) => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => providerResponse(url, init, providers) ?? api.fetchImpl(url, init)) as unknown as Api['fetchImpl'];
    mountProject(<ProjectPage pollMs={0} />, fetchImpl, { path: `/cerita/${ID}?tab=breakdown` });
    return screen.findByRole('region', { name: /mesin produksi/i });
  };
  const pick = async (box: RegExp, option: RegExp | string) => {
    await userEvent.click(within(screen.getByRole('region', { name: /mesin produksi/i })).getByRole('combobox', { name: box }));
    await userEvent.click(await screen.findByRole('option', { name: option }));
  };

  it('defaults to Google Flow for both and shows the Flow estimate', async () => {
    const section = await mount();
    expect(within(section).getByRole('combobox', { name: 'Mesin gambar' })).toHaveTextContent('Google Flow · gratis');
    expect(within(section).getByRole('combobox', { name: 'Mesin video' })).toHaveTextContent('Google Flow · gratis');
    expect(section).toHaveTextContent('4 klip × 10 kredit Flow = ±40 kredit');
  });

  it('picks OpenRouter for video: saves board.engine.video and shows clips × usdPerClip', async () => {
    const api = fakeProjectApi();
    const section = await mount(api);
    await pick(/mesin video/i, 'OpenRouter · Veo 3.1 Lite · ±$0,30/klip');
    await waitFor(() => expect(lastBoard(api)?.engine).toEqual({ video: { provider: 'openrouter', model: 'google/veo-3.1-lite' } }));
    expect(lastBoard(api)?.shots).toHaveLength(4);
    expect(await within(section).findByText('4 klip × ±$0,30 = ±$1,20')).toBeInTheDocument();
  });

  it('picks OpenRouter for images separately and keeps the video engine', async () => {
    const api = fakeProjectApi({ board: { ...BOARD, engine: { video: { provider: 'openrouter', model: 'google/veo-3.1' } } } });
    const section = await mount(api);
    await waitFor(() => expect(within(section).getByRole('combobox', { name: 'Mesin video' })).toHaveTextContent('OpenRouter · Veo 3.1 · ±$2,40/klip'));
    expect(section).toHaveTextContent('4 klip × ±$2,40 = ±$9,60');
    await pick(/mesin gambar/i, /^OpenRouter · Nano Banana/);
    await waitFor(() => expect(lastBoard(api)?.engine).toEqual({
      image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' },
      video: { provider: 'openrouter', model: 'google/veo-3.1' }
    }));
    await pick(/mesin video/i, 'Google Flow · gratis');
    await waitFor(() => expect((lastBoard(api)?.engine as Record<string, unknown>)?.video).toEqual({ provider: 'flow' }));
  });

  it('OpenRouter is disabled with the setup hint when it is not configured', async () => {
    await mount(fakeProjectApi(), UNCONFIGURED);
    await userEvent.click(within(screen.getByRole('region', { name: /mesin produksi/i })).getByRole('combobox', { name: 'Mesin video' }));
    const option = await screen.findByRole('option', { name: /^OpenRouter/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(option).toHaveTextContent('Atur di Pengaturan › Provider');
  });

  it('mode Cepat makes no images, so the image picker is replaced by a note', async () => {
    const section = await mount(fakeProjectApi({ board: { ...BOARD, mode: 'cepat' } }));
    expect(within(section).queryByRole('combobox', { name: 'Mesin gambar' })).toBeNull();
    expect(section).toHaveTextContent(/tidak dipakai di mode cepat/i);
  });

  it('is locked while the project is processing', async () => {
    const section = await mount(fakeProjectApi({ story: storyFor(BOARD, [], [], { status: 'rendering' }) }));
    expect(within(section).getByRole('combobox', { name: 'Mesin video' })).toBeDisabled();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { fakeProjectApi, ID, mountProject } from './testkit.js';

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
    expect(jingga.querySelector('img')?.getAttribute('src')).toMatch(/\/cast\/JINGGA\/image/);
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

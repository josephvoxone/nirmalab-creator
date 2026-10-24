import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, bodyOf, fakeFetch, ok } from '../../test/fake.js';
import { CATALOG } from '../stories/testCatalog.js';

function app(path = '/') {
  const drafts: Array<Record<string, unknown>> = [];
  const fetchImpl = fakeFetch((url, init) => {
    if (url === '/api/auth/me') return ok({ user: admin });
    if (url === '/api/stories') return ok({ stories: [] });
    if (url === '/api/stories/catalog') return ok({ catalog: CATALOG, covers: {} });
    if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
    if (url === '/api/stories/draft') { drafts.push(bodyOf(init)); return ok({ story: { id: 'story_n', title: 'N', status: 'draft', shots: [], events: [], createdAtMs: 0, updatedAtMs: 0 } }); }
    if (url === '/api/stories/story_n') return ok({ story: { id: 'story_n', title: 'N', status: 'draft', shots: [], events: [], createdAtMs: 0, updatedAtMs: 0 }, storyboard: { title: 'N', shots: [] } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath={path} />);
  return drafts;
}

const openLook = async () => userEvent.click(await screen.findByRole('button', { name: /atur gaya/i }));

describe('Home · look (Higgsfield-style chips on the prompt)', () => {
  it('a template sets the look chips, mode and shot count from its tempo', async () => {
    app();
    await userEvent.click(within(await screen.findByRole('list', { name: /mulai dari template/i })).getByRole('button', { name: /dongeng tidur/i }));
    await openLook();
    expect(screen.getByRole('button', { name: /Palet warna.*Pastel Kapas/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Film setup.*Dongeng/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mode' })).toHaveTextContent('Konsisten');
    expect(screen.getByRole('button', { name: 'Durasi' })).toHaveTextContent('6 shot');
  });

  it('palette dialog picks and Esc closes', async () => {
    app();
    await openLook();
    await userEvent.click(screen.getByRole('button', { name: /Palet warna/ }));
    const dialog = screen.getByRole('dialog', { name: 'Palet warna' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Noir Monokrom/ }));
    expect(screen.getByRole('button', { name: /Palet warna.*Noir Monokrom/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Kamera/ }));
    expect(screen.getByRole('dialog', { name: 'Kamera' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Kamera' })).toBeNull());
  });

  it('tempo in film setup sets the shot count', async () => {
    app();
    await openLook();
    await userEvent.click(screen.getByRole('button', { name: /Film setup/ }));
    const dialog = screen.getByRole('dialog', { name: 'Film setup' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tempo' }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Dinamis/ }));
    expect(screen.getByRole('button', { name: 'Durasi' })).toHaveTextContent('10 shot');
  });

  it('sends the chosen look with the draft', async () => {
    const drafts = app();
    await userEvent.click(within(await screen.findByRole('list', { name: /mulai dari template/i })).getByRole('button', { name: /drama hewan/i }));
    await userEvent.click(screen.getByRole('button', { name: /buat video/i }));
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject({ template: 'drama-hewan', shots: 8, look: { genre: 'drama', palette: 'senja', style: 'storybook' } });
  });

  it('prefills the prompt from ?prompt= (e.g. a script from Naskah & suara)', async () => {
    app('/?prompt=' + encodeURIComponent('Naskah tentang laut dalam'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Naskah tentang laut dalam'));
  });
});

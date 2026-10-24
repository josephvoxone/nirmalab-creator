import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, bodyOf, CATALOG, fail, fakeFetch, ok, STORIES } from '../../test/fake.js';

function app(path = '/', opts: { catalogFail?: boolean; draftFail?: boolean } = {}) {
  const drafts: unknown[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    if (url === '/api/auth/me') return ok({ user: admin });
    if (url === '/api/stories') return ok({ stories: STORIES });
    if (url === '/api/stories/catalog') return opts.catalogFail ? fail(500, 'katalog rusak') : ok({ catalog: CATALOG, covers: {} });
    if (url === '/api/stories/draft' && init?.method === 'POST') {
      drafts.push(bodyOf(init));
      return opts.draftFail ? fail(502, 'LLM tidak menjawab') : ok({ story: { ...STORIES[0], id: 'story_new', events: [] } });
    }
    if (url === '/api/stories/story_new') return ok({ story: { ...STORIES[0], id: 'story_new', events: [] }, storyboard: { title: 'Baru', shots: [] } });
    if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath={path} />);
  return { fetchImpl, drafts };
}

describe('Home · prompt to video', () => {
  it('greets with one question and a prompt box', async () => {
    app();
    expect(await screen.findByRole('heading', { name: /mau bikin video apa/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /prompt/i })).toBeInTheDocument();
  });

  it('turns a prompt into a story draft with the chosen mode and opens it', async () => {
    const { drafts, fetchImpl } = app();
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    await userEvent.click(screen.getByRole('button', { name: /mode/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /cepat/i }));
    await userEvent.type(box, 'Anak nelayan menemukan mutiara ajaib{Enter}');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject({ premise: 'Anak nelayan menemukan mutiara ajaib', mode: 'cepat', aspect: '9:16' });
    await waitFor(() => expect(fetchImpl.mock.calls.some(c => c[0] === '/api/stories/story_new')).toBe(true));
  });

  it('starts from a template suggestion: fills the example and sends the template', async () => {
    const { drafts } = app();
    const suggestions = await screen.findByRole('list', { name: /mulai dari template/i });
    await userEvent.click(within(suggestions).getByRole('button', { name: /dongeng tidur/i }));
    const box = screen.getByRole('textbox', { name: /prompt/i });
    expect(box).toHaveValue('Bintang kecil bernama Kerlip takut gelap.');
    expect(screen.getByText('Dongeng Tidur', { selector: '[data-slot="template-tag"] *' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /buat video/i }));
    await waitFor(() => expect(drafts[0]).toMatchObject({ template: 'dongeng-anak', mode: 'konsisten', look: { style: 'storybook', genre: 'drama' } }));
  });

  it('preselects a template from ?template=', async () => {
    app('/?template=promo-produk');
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    await waitFor(() => expect(box).toHaveValue('Kopi susu gula aren dari warung kecil.'));
  });

  it('keeps the prompt when the draft fails and says why', async () => {
    app('/', { draftFail: true });
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    await userEvent.type(box, 'Premis gagal{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/llm tidak menjawab/i);
    expect(box).toHaveValue('Premis gagal');
  });

  it('still lets you prompt when templates fail to load', async () => {
    app('/', { catalogFail: true });
    expect(await screen.findByText(/template tidak termuat/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /prompt/i })).toBeEnabled();
  });
});

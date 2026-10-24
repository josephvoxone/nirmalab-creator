import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, bodyOf, CATALOG, fakeFetch, ok, STORIES } from '../../test/fake.js';
import { CONFIGURED, MODELS, UNCONFIGURED } from '../providers/fixtures.js';
import type { Providers } from '../providers/providersClient.js';

function app(providers: Providers | null = CONFIGURED) {
  const drafts: Array<Record<string, unknown>> = [];
  const fetchImpl = fakeFetch((url, init) => {
    if (url === '/api/auth/me') return ok({ user: admin });
    if (url === '/api/stories') return ok({ stories: STORIES });
    if (url === '/api/stories/catalog') return ok({ catalog: CATALOG, covers: {} });
    if (url === '/api/providers') return providers ? ok(providers) : { status: 403, body: { error: { message: 'Admin only' } } };
    if (url === '/api/providers/openrouter/models') return ok(MODELS);
    if (url === '/api/stories/draft' && init?.method === 'POST') {
      drafts.push(bodyOf(init));
      return ok({ story: { ...STORIES[0], id: 'story_new', events: [] } });
    }
    if (url === '/api/stories/story_new') return ok({ story: { ...STORIES[0], id: 'story_new', events: [] }, storyboard: { title: 'Baru', shots: [] } });
    if (url === '/api/flow/accounts') return ok({ accounts: [], bridge: { online: true } });
    return undefined;
  });
  render(<App fetchImpl={fetchImpl} initialPath="/" />);
  return { drafts };
}

describe('Home · Mesin', () => {
  it('defaults to Google Flow and sends it as engine in the draft', async () => {
    const { drafts } = app();
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    expect(screen.getByRole('button', { name: 'Mesin: Google Flow · gratis' })).toBeInTheDocument();
    await userEvent.type(box, 'Kucing menunggu{Enter}');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].engine).toEqual({ image: { provider: 'flow' }, video: { provider: 'flow' } });
  });

  it('OpenRouter shows the default model + price, the cost in USD, and sends both default models', async () => {
    const { drafts } = app();
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    await userEvent.click(screen.getByRole('button', { name: /^mesin/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'OpenRouter · Veo 3.1 Lite · ±$0,30/klip' }));
    expect(await screen.findByRole('button', { name: 'Mesin: OpenRouter · Veo 3.1 Lite · ±$0,30/klip' })).toBeInTheDocument();
    expect(screen.getByText(/±\$2,40 render/)).toBeInTheDocument();
    expect(screen.queryByText(/kredit render/)).toBeNull();
    await userEvent.type(box, 'Kucing menunggu{Enter}');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].engine).toEqual({
      image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' },
      video: { provider: 'openrouter', model: 'google/veo-3.1-lite' }
    });
  });

  it.each([['not configured', UNCONFIGURED], ['not readable', null]] as const)('OpenRouter is disabled with the setup hint when %s', async (_, providers) => {
    app(providers);
    await screen.findByRole('textbox', { name: /prompt/i });
    await userEvent.click(screen.getByRole('button', { name: /^mesin/i }));
    const item = await screen.findByRole('menuitemradio', { name: /^OpenRouter/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Atur di Pengaturan › Provider');
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StudioPage } from './StudioPage.js';
import type { Technique } from './compose.js';
import { CONFIGURED, UNCONFIGURED, providerResponse } from '../providers/fixtures.js';
import type { Providers } from '../providers/providersClient.js';

const techniques: Technique[] = [{ c: 'camera-movement', s: 'dolly-in', n: 'Dolly In', d: 'Camera moves forward.', p: 'The camera dollies toward [Subject].' }];
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const account = { id: 'acc_1', label: 'Akun 1', email: 'a@b.c', status: 'ready', creditsUsedToday: 0, credits: 100 };
const job = { id: 'job_aaaaaaaaaaaaaaaa', prompt: 'ombak', status: 'queued', aspect: '9:16', durationSec: 6, attempts: 0, createdAtMs: 1 };

function setup(opts: { providers?: Providers | null; post?: (body: Record<string, unknown>, n: number) => Response } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const p = providerResponse(url, init, opts.providers === undefined ? CONFIGURED : opts.providers);
    if (p) return p;
    if (url.endsWith('/api/flow/jobs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return opts.post ? opts.post(body, posts.length) : json({ job });
    }
    if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { online: true } });
    if (url.endsWith('/api/flow/jobs')) return json({ jobs: [] });
    return json({}, 404);
  });
  render(
    <MemoryRouter initialEntries={['/studio']}>
      <Routes><Route path="/studio" element={<StudioPage baseUrl="" fetchImpl={fetchImpl as unknown as typeof fetch} techniques={techniques} />} /></Routes>
    </MemoryRouter>
  );
  return { posts, fetchImpl };
}

async function toPrompt(user: ReturnType<typeof userEvent.setup>, kind: RegExp) {
  await screen.findByText(/bridge online/i);
  await user.click(screen.getByRole('button', { name: kind }));
  await user.click(screen.getByRole('button', { name: /tanpa preset/i }));
  await user.type(screen.getByLabelText(/subjek/i), 'perahu kertas');
}

describe('Studio · Mesin', () => {
  it('Google Flow is the default and sends no provider', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await toPrompt(user, /video 6 detik/i);
    expect(screen.getByRole('combobox', { name: 'Mesin' })).toHaveTextContent('Google Flow · gratis');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('provider');
    expect(posts[0]).not.toHaveProperty('model');
  });

  it('OpenRouter video sends provider + the default video model', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await toPrompt(user, /video 6 detik/i);
    await user.click(screen.getByRole('combobox', { name: 'Mesin' }));
    await user.click(await screen.findByRole('option', { name: 'OpenRouter · Veo 3.1 Lite · ±$0,30/klip' }));
    expect(screen.getByRole('combobox', { name: 'Mesin' })).toHaveTextContent('OpenRouter · Veo 3.1 Lite · ±$0,30/klip');
    expect(screen.getByRole('complementary', { name: /prompt akhir/i })).toHaveTextContent(/±\$0,30 via OpenRouter/);
    await user.click(screen.getByRole('button', { name: /antrekan ke openrouter/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ provider: 'openrouter', model: 'google/veo-3.1-lite', durationSec: 6, aspect: '9:16' });
    expect(posts[0]).not.toHaveProperty('force');
  });

  it('OpenRouter image sends kind image + the default image model', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await toPrompt(user, /^gambar/i);
    await user.click(screen.getByRole('combobox', { name: 'Mesin' }));
    await user.click(await screen.findByRole('option', { name: 'OpenRouter · Nano Banana · ±$0,04/gambar' }));
    await user.click(screen.getByRole('button', { name: /antrekan ke openrouter/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
  });

  it.each([['not configured', UNCONFIGURED], ['not readable (member)', null]] as const)('OpenRouter is disabled with the setup hint when %s', async (_, providers) => {
    const user = userEvent.setup();
    setup({ providers });
    await toPrompt(user, /video 6 detik/i);
    await user.click(screen.getByRole('combobox', { name: 'Mesin' }));
    const option = await screen.findByRole('option', { name: /^OpenRouter/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(option).toHaveTextContent('Atur di Pengaturan › Provider');
  });

  it('a 402 BUDGET shows the server text verbatim and Render tetap re-sends with force', async () => {
    const user = userEvent.setup();
    const message = 'Butuh ±$2,40, saldo OpenRouter $0,50';
    const { posts } = setup({ post: (_, n) => (n === 1 ? json({ error: { code: 'BUDGET', message } }, 402) : json({ job })) });
    await toPrompt(user, /video 6 detik/i);
    await user.click(screen.getByRole('combobox', { name: 'Mesin' }));
    await user.click(await screen.findByRole('option', { name: /^OpenRouter · Veo 3\.1 Lite/ }));
    await user.click(screen.getByRole('button', { name: /antrekan ke openrouter/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    await user.click(within(alert).getByRole('button', { name: 'Render tetap' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ ...posts[0], force: true });
    await waitFor(() => expect(within(screen.getByRole('list', { name: /langkah studio/i })).getByRole('button', { name: 'Hasil' })).toHaveAttribute('aria-current', 'step'));
    expect(screen.queryByRole('button', { name: 'Render tetap' })).toBeNull();
  });
});

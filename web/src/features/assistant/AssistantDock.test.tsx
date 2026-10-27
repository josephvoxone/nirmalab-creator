import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from '../project/ProjectPage.js';
import { bibleBoard, fakeProjectApi, ID, mountProject, storyFor } from '../project/testkit.js';
import { AssistantColumn, OPEN_KEY, type AssistantDock } from './AssistantDock.js';
import type { AssistantPanelProps } from './AssistantPanel.js';
import { fakeAssistantApi, memoryStorage, mockMatchMedia, mountWith, SID } from './testkit.js';

let restore: () => void = () => undefined;
afterEach(() => restore());

function api() {
  return fakeProjectApi({
    extra: (call, json) => (call.url === `/api/stories/${ID}/assistant` && call.method === 'GET' ? json(200, { turns: [], configured: true }) : undefined)
  });
}

describe('assistant on the project page', () => {
  it('lg+: a column beside the tabs; hiding it is remembered across visits', async () => {
    const media = mockMatchMedia(() => true);
    const storage = memoryStorage();
    restore = () => { media(); storage.restore(); };
    const fake = api();
    const first = mountProject(<ProjectPage pollMs={60_000} />, fake.fetchImpl);
    const column = await screen.findByRole('complementary', { name: 'Kolom asisten' });
    expect(await within(column).findByText('Tanya atau suruh apa saja tentang proyek ini.')).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    await userEvent.setup().click(within(column).getByRole('button', { name: 'Sembunyikan asisten' }));
    expect(screen.queryByRole('complementary', { name: 'Kolom asisten' })).toBeNull();
    expect(storage.store.getItem(OPEN_KEY)).toBe('0');
    expect(screen.getByRole('button', { name: 'Tampilkan asisten' })).toBeInTheDocument();
    first.unmount();

    mountProject(<ProjectPage pollMs={60_000} />, fake.fetchImpl);
    const show = await screen.findByRole('button', { name: 'Tampilkan asisten' });
    expect(screen.queryByRole('complementary', { name: 'Kolom asisten' })).toBeNull();
    await userEvent.setup().click(show);
    expect(await screen.findByRole('complementary', { name: 'Kolom asisten' })).toBeInTheDocument();
    expect(storage.store.getItem(OPEN_KEY)).toBe('1');
  });

  it('a blocked localStorage still lets the column open and close', async () => {
    const media = mockMatchMedia(() => true);
    const storage = memoryStorage({ blocked: true });
    restore = () => { media(); storage.restore(); };
    mountProject(<ProjectPage pollMs={60_000} />, api().fetchImpl);
    const column = await screen.findByRole('complementary', { name: 'Kolom asisten' });
    await userEvent.setup().click(within(column).getByRole('button', { name: 'Sembunyikan asisten' }));
    expect(screen.getByRole('button', { name: 'Tampilkan asisten' })).toBeInTheDocument();
  });

  it('below lg: the header button "Asisten" opens the panel in a sheet', async () => {
    restore = mockMatchMedia(() => false);
    const fake = api();
    mountProject(<ProjectPage pollMs={60_000} />, fake.fetchImpl);
    const open = await screen.findByRole('button', { name: 'Asisten' });
    expect(screen.queryByRole('complementary', { name: 'Kolom asisten' })).toBeNull();
    expect(fake.calls.some(c => c.url.endsWith('/assistant'))).toBe(false);
    await userEvent.setup().click(open);
    const sheet = await screen.findByRole('dialog', { name: 'Asisten proyek' });
    expect(await within(sheet).findByRole('combobox', { name: 'Pesan untuk asisten' })).toBeInTheDocument();
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Tutup asisten' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Asisten proyek' })).toBeNull());
    expect(document.querySelectorAll('select, input[type=date], input[type=radio], input[type=checkbox]')).toHaveLength(0);
  });

  it('Escape while a reply streams stops it and keeps the sheet open', async () => {
    restore = mockMatchMedia(() => false);
    let signal: AbortSignal | undefined;
    const fake = fakeProjectApi({
      extra: (call, json) => {
        if (call.url !== `/api/stories/${ID}/assistant`) return undefined;
        if (call.method === 'GET') return json(200, { turns: [], configured: true });
        return new Response(new ReadableStream({ start() { /* never ends until aborted */ } }), { status: 200 });
      }
    });
    const realFetch = fake.fetchImpl.getMockImplementation()!;
    fake.fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/stories/${ID}/assistant` && init?.method === 'POST') signal = init.signal ?? undefined;
      return realFetch(url, init);
    });
    mountProject(<ProjectPage pollMs={60_000} />, fake.fetchImpl);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Asisten' }));
    const sheet = await screen.findByRole('dialog', { name: 'Asisten proyek' });
    const box = await within(sheet).findByRole('combobox', { name: 'Pesan untuk asisten' });
    await user.type(box, 'Ringkas proyek ini{Enter}');
    await within(sheet).findByRole('button', { name: 'Hentikan jawaban' });
    box.focus();
    await user.keyboard('{Escape}');
    expect(signal?.aborted).toBe(true);
    expect(await within(sheet).findByRole('button', { name: 'Kirim pesan' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Asisten proyek' })).toBeInTheDocument();
  });

  it('lg+: the column is a fixed 380 px and the page widens with it; focus follows hide/show', async () => {
    const media = mockMatchMedia(() => true);
    const storage = memoryStorage();
    restore = () => { media(); storage.restore(); };
    mountProject(<ProjectPage pollMs={60_000} />, api().fetchImpl);
    const column = await screen.findByRole('complementary', { name: 'Kolom asisten' });
    expect(column).toHaveClass('w-[380px]', 'shrink-0');
    const page = column.parentElement!;
    expect(page).toHaveClass('max-w-[1520px]');
    const user = userEvent.setup();
    await user.click(await within(column).findByRole('button', { name: 'Sembunyikan asisten' }));
    const show = screen.getByRole('button', { name: 'Tampilkan asisten' });
    await waitFor(() => expect(show).toHaveFocus());
    expect(page).toHaveClass('max-w-[1200px]');
    await user.click(show);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sembunyikan asisten' })).toHaveFocus());
    expect(page).toHaveClass('max-w-[1520px]');
  });

  it('below lg: opening the sheet puts the cursor in the composer', async () => {
    restore = mockMatchMedia(() => false);
    mountProject(<ProjectPage pollMs={60_000} />, api().fetchImpl);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Asisten' }));
    const sheet = await screen.findByRole('dialog', { name: 'Asisten proyek' });
    const box = await within(sheet).findByRole('combobox', { name: 'Pesan untuk asisten' });
    await waitFor(() => expect(box).toHaveFocus());
  });
});

describe('assistant column', () => {
  const dock = { wide: true, open: true, sheet: false, toggle: () => undefined, setSheet: () => undefined } as unknown as AssistantDock;
  const board = bibleBoard();
  const storyA = { ...storyFor(board), id: SID, rev: 2 };

  it('state does not leak from one project to the next', async () => {
    const fake = fakeAssistantApi();
    function Switch() {
      const [story, setStory] = useState(storyA);
      return (
        <>
          <button type="button" onClick={() => setStory({ ...storyA, id: 'story_fedcba9876543210' })}>Proyek lain</button>
          <AssistantColumn dock={dock} story={story} board={board} onChanged={() => undefined} />
        </>
      );
    }
    mountWith(<Switch />, fake.fetchImpl);
    const user = userEvent.setup();
    const box = await screen.findByRole('combobox', { name: 'Pesan untuk asisten' });
    await user.type(box, 'draf untuk proyek A');
    await user.click(screen.getByRole('button', { name: 'Proyek lain' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Pesan untuk asisten' })).toHaveValue(''));
  });

  it('a chunk that fails to load shows an inline error with Coba lagi; the page keeps working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const load = () => (++calls === 1
      ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
      : Promise.resolve({ default: (p: AssistantPanelProps) => <p>panel siap {p.story.id}</p> }));
    mountWith(<><p>halaman tetap</p><AssistantColumn dock={dock} story={storyA} board={board} onChanged={() => undefined} load={load} /></>, fakeAssistantApi().fetchImpl);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Asisten gagal dimuat');
    expect(screen.getByText('halaman tetap')).toBeInTheDocument();
    await userEvent.setup().click(within(alert).getByRole('button', { name: /Coba lagi/ }));
    expect(await screen.findByText(`panel siap ${SID}`)).toBeInTheDocument();
    expect(calls).toBe(2);
    vi.restoreAllMocks();
  });
});

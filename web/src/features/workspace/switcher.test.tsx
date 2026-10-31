import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { admin, fail, fakeFetch, ok, STORIES, type Handler } from '../../test/fake.js';

const WORKSPACES = [
  { id: 'w1', name: 'Ruang kerja Joseph', role: 'owner', personal: true, projects: 6, members: 1 },
  { id: 'w2', name: 'Tim Nirmalab', role: 'editor', personal: false, projects: 3, members: 3 }
];

function app(handler: Handler) {
  const fetchImpl = fakeFetch(handler);
  render(<App fetchImpl={fetchImpl} initialPath="/" />);
  return fetchImpl;
}

const base = (workspaces: unknown) => (url: string) => {
  if (url === '/api/auth/me') return ok({ user: admin });
  if (url === '/api/workspaces') return ok({ workspaces });
  if (url.startsWith('/api/stories?') || url === '/api/stories') return ok({ stories: STORIES });
  if (url === '/api/quota') return ok({ flow: { credits: 40, usedToday: 10, capToday: 50, accounts: 1, online: true }, openrouter: { configured: false }, storage: { usedBytes: 1, diskFreeBytes: null } });
  if (url === '/api/stories/catalog') return ok({ catalog: { templates: [] }, covers: {} });
  return undefined;
};

describe('Pengalih workspace', () => {
  it('shows the workspaces you belong to with your role, and remembers the one you pick', async () => {
    const asked: string[] = [];
    const fetchImpl = app(url => {
      if (url.startsWith('/api/stories')) asked.push(url);
      return base(WORKSPACES)(url);
    });
    const picker = await screen.findByRole('combobox', { name: 'Workspace' });
    expect(picker).toHaveTextContent('Ruang kerja Joseph');
    // The role of the workspace you are looking at is spelled out under the picker.
    expect(screen.getByText('Pemilik')).toBeInTheDocument();
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole('option', { name: /Tim Nirmalab/ }));
    await waitFor(() => expect(asked.some(u => u === '/api/stories?workspace=w2')).toBe(true));
    // The switcher (and the project pages) read the role of the workspace now in view.
    await waitFor(() => expect(document.querySelector('[data-role="editor"]')).not.toBeNull());
    expect(picker).toHaveTextContent('Tim Nirmalab');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('stays out of the way when you only have your personal workspace', async () => {
    let answered = false;
    app(url => {
      if (url === '/api/workspaces') { answered = true; return ok({ workspaces: [WORKSPACES[0]] }); }
      return base([WORKSPACES[0]])(url);
    });
    await screen.findByRole('navigation', { name: /menu utama/i });
    // Let the workspace list land and commit before deciding it is absent — otherwise the
    // assertion would pass on the first frame, before the provider has data.
    await waitFor(() => expect(answered).toBe(true));
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  it('drops the picker quietly when the workspace list cannot be loaded', async () => {
    app(url => url === '/api/workspaces' ? fail(500, 'server sedang bermasalah') : base([WORKSPACES[1]])(url));
    const nav = await screen.findByRole('navigation', { name: /menu utama/i });
    expect(within(nav).queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
  });
});

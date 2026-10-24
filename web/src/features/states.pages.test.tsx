import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../lib/session.js';
import type { User } from '../lib/api.js';
import { StudioPage } from './studio/StudioPage.js';
import PublishPage from './publish/PublishPage.js';
import SettingsPage from './settings/SettingsPage.js';

const admin: User = { id: 'u1', email: 'a@x.io', isAdmin: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function withSession(node: React.ReactNode, fetchImpl: ReturnType<typeof vi.fn>) {
  return render(
    <SessionContext.Provider value={{ user: admin, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter>{node}</MemoryRouter>
    </SessionContext.Provider>
  );
}

describe('Settings states', () => {
  it('no Flow account yet → empty state that says what to add', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/flow/accounts')) return json({ accounts: [], bridge: { online: false } });
      if (url.includes('/invites')) return json({ invites: [] });
      return json({});
    });
    withSession(<SettingsPage tab="flow" />, fetchImpl);
    expect(await screen.findByRole('heading', { name: 'Belum ada akun Flow' })).toBeTruthy();
  });
});

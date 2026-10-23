import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const admin = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };

describe('App shell', () => {
  it('sends a visitor without a session to the login page and signs in', async () => {
    let signedIn = false;
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/me') return signedIn ? { status: 200, body: { user: admin } } : { status: 401, body: { error: { message: 'Unauthorized' } } };
      if (url === '/api/auth/login' && init?.method === 'POST') { signedIn = true; return { status: 200, body: { user: admin } }; }
      if (url === '/api/stories') return { status: 200, body: { stories: [] } };
      return { status: 404, body: {} };
    });
    render(<App fetchImpl={fetchImpl} initialPath="/cerita" />);
    expect(await screen.findByRole('heading', { name: /masuk/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/email/i), 'joseph@nirmalab.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret-pass-1');
    await userEvent.click(screen.getByRole('button', { name: /masuk/i }));
    expect(await screen.findByRole('heading', { name: /cerita/i, level: 1 })).toBeInTheDocument();
  });

  it('shows the five sections in the sidebar and the account only in the avatar popover', async () => {
    const fetchImpl = fakeFetch(url => (url === '/api/auth/me' ? { status: 200, body: { user: admin } } : { status: 200, body: { stories: [] } }));
    render(<App fetchImpl={fetchImpl} initialPath="/cerita" />);
    const nav = await screen.findByRole('navigation', { name: /menu utama/i });
    for (const label of ['Cerita', 'Studio', 'Generate', 'Publish', 'Pengaturan']) {
      expect(nav).toHaveTextContent(label);
    }
    expect(screen.queryByText(admin.email)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /akun/i }));
    expect(screen.getByText(admin.email)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /keluar/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText(admin.email)).not.toBeInTheDocument();
  });

  it('accepts an invite on /join/<token> and lands signed in', async () => {
    let signedIn = false;
    const token = 'tok_abcdefghijklmnopqrstuvwxyz';
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/me') return signedIn ? { status: 200, body: { user: { ...admin, isAdmin: false } } } : { status: 401, body: {} };
      if (url.startsWith('/api/auth/invites/peek')) return { status: 200, body: { valid: true, email: 'baru@nirmalab.com' } };
      if (url === '/api/auth/invites/accept' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ token, email: 'baru@nirmalab.com' });
        signedIn = true;
        return { status: 200, body: { user: admin } };
      }
      return { status: 200, body: { stories: [] } };
    });
    render(<App fetchImpl={fetchImpl} initialPath={`/join/${token}`} />);
    expect(await screen.findByRole('heading', { name: /gabung/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveValue('baru@nirmalab.com'));
    await userEvent.type(screen.getByLabelText(/password/i), 'secret-pass-1');
    await userEvent.click(screen.getByRole('button', { name: /buat akun/i }));
    expect(await screen.findByRole('heading', { name: /cerita/i, level: 1 })).toBeInTheDocument();
  });

  it('shows the login error message from the server', async () => {
    const fetchImpl = fakeFetch(url => (url === '/api/auth/login'
      ? { status: 401, body: { error: { message: 'Email atau password salah' } } }
      : { status: 401, body: {} }));
    render(<App fetchImpl={fetchImpl} initialPath="/" />);
    await userEvent.type(await screen.findByLabelText(/email/i), 'x@y.io');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: /masuk/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email atau password salah');
  });
});

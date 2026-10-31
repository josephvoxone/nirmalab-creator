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

const admin = { id: 'u1', email: 'joseph@example.com', isAdmin: true };

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
    await userEvent.type(screen.getByLabelText(/email/i), 'joseph@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret-pass-1');
    await userEvent.click(screen.getByRole('button', { name: /masuk/i }));
    expect(await screen.findByRole('heading', { name: /mau bikin video apa/i })).toBeInTheDocument();
  });

  it('shows the ChatGPT-style sidebar and keeps the account in its menu', async () => {
    const fetchImpl = fakeFetch(url => (url === '/api/auth/me' ? { status: 200, body: { user: admin } } : { status: 200, body: { stories: [] } }));
    render(<App fetchImpl={fetchImpl} initialPath="/cerita" />);
    const nav = await screen.findByRole('navigation', { name: /menu utama/i });
    for (const label of ['Buat baru', 'Cari cerita', 'Template', 'Studio', 'Naskah & suara', 'Publish', 'Proyek']) {
      expect(nav).toHaveTextContent(label);
    }
    expect(screen.queryByText(admin.email)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /akun/i }));
    expect(await screen.findByText(admin.email)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /keluar/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(admin.email)).not.toBeInTheDocument());
  });

  it('accepts a workspace invite on /join/<token> and lands signed in', async () => {
    // Wave 4: the invite is a WORKSPACE invite (GET/POST /api/join/:token) with a role; the old platform-invite
    // endpoints are gone from this page, so the shell proves the same outcome through the new contract.
    let signedIn = false;
    const token = 'tok_abcdefghijklmnopqrstuvwxyz';
    const fetchImpl = fakeFetch((url, init) => {
      if (url === '/api/auth/me') return signedIn ? { status: 200, body: { user: { ...admin, isAdmin: false } } } : { status: 401, body: {} };
      if (url === `/api/join/${token}` && !init?.method) return { status: 200, body: { workspace: { name: 'Tim Contoh' }, role: 'editor', email: 'baru@example.com', needsAccount: true } };
      if (url === `/api/join/${token}` && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ password: 'secret-pass-1' });
        signedIn = true;
        return { status: 200, body: { user: { ...admin, isAdmin: false } } };
      }
      return { status: 200, body: { stories: [] } };
    });
    render(<App fetchImpl={fetchImpl} initialPath={`/join/${token}`} />);
    expect(await screen.findByRole('heading', { name: /gabung ke tim contoh/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: /email undangan/i })).toHaveValue('baru@example.com'));
    await userEvent.type(screen.getByLabelText(/kata sandi/i), 'secret-pass-1');
    await userEvent.click(screen.getByRole('button', { name: /buat akun|bergabung/i }));
    expect(await screen.findByRole('heading', { name: /mau bikin video apa/i })).toBeInTheDocument();
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

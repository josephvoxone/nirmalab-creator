import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { bodyOf, fakeFetch, ok } from '../../test/fake.js';
import { JoinPage } from './JoinPage.js';

const INVITE = { workspace: { name: 'Tim Nirmalab' }, role: 'editor', email: 'b@nirmalab.com', needsAccount: true };

function mount(handler: Parameters<typeof fakeFetch>[0]) {
  const fetchImpl = fakeFetch(handler);
  const onSignedIn = vi.fn();
  render(<MemoryRouter><JoinPage token="tok_1" fetchImpl={fetchImpl} onSignedIn={onSignedIn} /></MemoryRouter>);
  return { fetchImpl, onSignedIn };
}

describe('/join/:token', () => {
  it('names the workspace and role before asking anything, and creates the account with the invite', async () => {
    const calls: unknown[] = [];
    const { onSignedIn } = mount((url, init) => {
      if (url === '/api/join/tok_1' && !init?.method) return ok(INVITE);
      if (url === '/api/join/tok_1' && init?.method === 'POST') {
        calls.push(bodyOf(init));
        return ok({ user: { id: 'u9', email: 'b@nirmalab.com', isAdmin: false } });
      }
      return undefined;
    });
    expect(await screen.findByRole('heading', { name: /gabung ke Tim Nirmalab/i })).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Email undangan' })).toHaveValue('b@nirmalab.com');
    const form = screen.getByRole('form', { name: 'Gabung ke workspace' });
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');
    await userEvent.click(screen.getByRole('button', { name: /buat akun & gabung/i }));
    await waitFor(() => expect(calls).toEqual([{ password: 'rahasia123' }]));
    expect(onSignedIn).toHaveBeenCalledWith({ id: 'u9', email: 'b@nirmalab.com', isAdmin: false });
    expect(form).toBeInTheDocument();
  });

  it('asks for nothing but a confirmation when the invitee already has an account', async () => {
    const calls: unknown[] = [];
    mount((url, init) => {
      if (url === '/api/join/tok_1' && !init?.method) return ok({ ...INVITE, needsAccount: false });
      if (url === '/api/join/tok_1') { calls.push(bodyOf(init)); return ok({ user: { id: 'u2', email: 'b@nirmalab.com', isAdmin: false } }); }
      return undefined;
    });
    expect(await screen.findByRole('heading', { name: /gabung ke Tim Nirmalab/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Kata sandi')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gabung ke workspace' }));
    await waitFor(() => expect(calls).toEqual([{}]));
  });

  it('says plainly that an expired or used token cannot be used, and offers the way back', async () => {
    mount(url => url === '/api/join/tok_1' ? { status: 410, body: { error: { message: 'Undangan kedaluwarsa' } } } : undefined);
    expect(await screen.findByRole('heading', { name: 'Undangan tidak berlaku' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/kedaluwarsa atau sudah dipakai/i);
    expect(screen.getByRole('link', { name: /kembali ke beranda/i })).toHaveAttribute('href', '/');
  });
});

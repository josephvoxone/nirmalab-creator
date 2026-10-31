import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../test/fake.js';
import { LoginPage } from './LoginPage.js';

describe('Masuk · akun ditangguhkan', () => {
  it('shows the server\'s plain-Indonesian reason and does not sign in', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 403, body: { error: { code: 'ACCOUNT_SUSPENDED', message: 'Akun ini ditangguhkan oleh pengelola. Hubungi pengelola untuk mengaktifkannya kembali; proyek Anda tetap aman.' } } }));
    let signedIn = false;
    render(<LoginPage fetchImpl={fetchImpl} onSignedIn={() => { signedIn = true; }} />);
    await userEvent.type(screen.getByPlaceholderText('nama@email.com'), 'tim@example.com');
    await userEvent.type(screen.getByPlaceholderText('Password akunmu'), 'rahasia-123');
    await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ditangguhkan.*proyek anda tetap aman/i);
    expect(signedIn).toBe(false);
  });
});

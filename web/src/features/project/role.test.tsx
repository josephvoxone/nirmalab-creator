import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorState } from '../../ui/states.js';
import { ApiError } from '../../lib/api.js';
import { fakeProjectApi, mountProject } from './testkit.js';
import { ProjectPage } from './ProjectPage.js';

const page = (role: 'owner' | 'editor' | 'viewer') => {
  const api = fakeProjectApi({ role });
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { role });
  return api;
};

describe('Peran di halaman proyek', () => {
  it('shows my role next to the project; an editor keeps the write controls', async () => {
    page('editor');
    const panel = await screen.findByRole('tabpanel');
    expect(await screen.findByText('Editor')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Tambah scene' })).toBeInTheDocument();
    expect(screen.queryByText(/Kamu Penonton di workspace ini/i)).not.toBeInTheDocument();
  });

  it('gives a viewer one line of reason and no write affordances at all', async () => {
    page('viewer');
    const panel = await screen.findByRole('tabpanel');
    expect(await screen.findByText('Penonton')).toBeInTheDocument();
    expect(screen.getByText(/Kamu Penonton di workspace ini/i)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Tambah scene' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Tambah shot' })).not.toBeInTheDocument();
    // The project-wide primary action (prepare/render/assemble) is a write: gone for a viewer.
    expect(screen.queryByRole('button', { name: /siapkan keyframe|render|rakit/i })).not.toBeInTheDocument();
  });
});

describe('403 dan 404 di UI', () => {
  it('explains VIEWER_READ_ONLY as a role, not as a bug', () => {
    render(<ErrorState title="Tidak bisa menyimpan" error={new ApiError(403, 'Penonton tidak bisa mengubah proyek', 'VIEWER_READ_ONLY')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Penonton di workspace ini/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/naikkan peranmu ke Editor/i);
  });

  it('does not pretend a 404 is a network failure', () => {
    render(<ErrorState title="Proyek gagal dimuat" error={new ApiError(404, 'Tidak ditemukan')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/bukan anggota workspace ini/i);
  });
});

describe('Muatan rusak', () => {
  it('says the project could not be read instead of crashing on a payload without story', async () => {
    const api = fakeProjectApi({ extra: (call, json) => (call.method === 'GET' && call.url.startsWith('/api/stories/') && !call.url.endsWith('/catalog') ? json(200, {}) : undefined) });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { role: 'owner' });
    expect(await screen.findByRole('heading', { name: /gagal dimuat/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/coba lagi|tidak/i);
  });
});

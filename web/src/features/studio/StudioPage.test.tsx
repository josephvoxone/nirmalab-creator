import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StudioPage } from './StudioPage.js';
import type { Technique } from './compose.js';

const BASE = '';
const techniques: Technique[] = [
  { c: 'camera-movement', s: 'dolly-in', n: 'Dolly In', d: 'Camera moves forward.', p: 'The camera dollies toward [Subject].' },
  { c: 'lighting', s: 'rim-light', n: 'Rim Light', d: 'Light from behind.', p: 'Rim light outlines [Subject].' }
];

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const account = { id: 'acc_1', label: 'Akun 1', email: 'a@b.c', status: 'ready', creditsUsedToday: 2, credits: 103 };
const doneJob = { id: 'job_aaaaaaaaaaaaaaaa', prompt: 'ombak', status: 'done', aspect: '9:16', durationSec: 4, attempts: 0, createdAtMs: 1, accountId: 'acc_1' };

type Extra = Array<[RegExp, (init?: RequestInit) => Response]>;

function makeFetch(extra: Extra = [], jobs: unknown[] = [doneJob]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    for (const [re, fn] of extra) if (re.test(url) && (init?.method ?? 'GET') !== 'GET') return fn(init);
    if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { bridgeId: 'mac', online: true, lastSeenMs: Date.now() } });
    if (url.endsWith('/api/flow/jobs')) return json({ jobs });
    return json({}, 404);
  });
}

function SettingsProbe() {
  const { tab } = useParams();
  return <p>Pengaturan tab {tab}</p>;
}

function renderPage(fetchImpl: ReturnType<typeof vi.fn>, list: Technique[] = techniques) {
  render(
    <MemoryRouter initialEntries={['/studio']}>
      <Routes>
        <Route path="/studio" element={<StudioPage baseUrl={BASE} fetchImpl={fetchImpl as unknown as typeof fetch} techniques={list} />} />
        <Route path="/pengaturan/:tab" element={<SettingsProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

const stepper = () => screen.getByRole('list', { name: /langkah studio/i });
const stepButton = (name: string) => within(stepper()).getByRole('button', { name });
type User = ReturnType<typeof userEvent.setup>;

async function ready() {
  await screen.findByText(/bridge online/i);
}

async function toPrompt(user: User, kind: RegExp = /video 6 detik/i) {
  await user.click(screen.getByRole('button', { name: kind }));
  await user.click(screen.getByRole('button', { name: /tanpa preset/i }));
  expect(stepButton('Prompt')).toHaveAttribute('aria-current', 'step');
}

function noNativeControls() {
  expect(document.querySelector('select')).toBeNull();
  expect(document.querySelector('input[type="radio"],input[type="checkbox"],input[type="date"],input[type="time"],input[type="datetime-local"]')).toBeNull();
}

describe('StudioPage — status bridge ringkas', () => {
  it('menampilkan satu baris status bridge + kredit, dan link Kelola akun Flow membuka Pengaturan › Flow', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await ready();
    expect(screen.getByText(/103 kredit/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /kelola akun flow/i }));
    expect(await screen.findByText('Pengaturan tab flow')).toBeTruthy();
  });

  it('tidak lagi memuat KPI, form akun, daftar akun, atau kartu Bridge Mac, dan tanpa h1 sendiri', async () => {
    renderPage(makeFetch());
    await ready();
    expect(screen.queryByRole('region', { name: /ringkasan/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /bridge mac/i })).toBeNull();
    expect(screen.queryByLabelText(/label akun/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /tambah akun/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hapus akun/i })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('gagal memuat menampilkan sebab yang jelas dan Coba lagi memuat ulang', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/flow/accounts')) {
        calls += 1;
        if (calls === 1) return json({ error: { message: 'database sedang restart' } }, 500);
        return json({ accounts: [account], bridge: { online: true } });
      }
      if (url.endsWith('/api/flow/jobs')) return json({ jobs: [] });
      return json({}, 404);
    });
    renderPage(fetchImpl);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('database sedang restart');
    expect(alert.textContent).not.toMatch(/at \w+ \(/);
    await user.click(within(alert).getByRole('button', { name: /coba lagi/i }));
    await ready();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('StudioPage — alur langkah', () => {
  it('mulai di Jenis; langkah berikutnya tidak bisa dilompati', async () => {
    renderPage(makeFetch());
    await ready();
    expect(stepButton('Jenis')).toHaveAttribute('aria-current', 'step');
    expect(stepButton('Gaya')).toBeDisabled();
    expect(stepButton('Prompt')).toBeDisabled();
    expect(stepButton('Hasil')).toBeDisabled();
    expect(screen.getByRole('button', { name: /video 6 detik/i })).toHaveTextContent(/10 kredit/i);
    expect(screen.getByRole('button', { name: /^gambar/i })).toHaveTextContent(/gratis/i);
  });

  it('bisa kembali ke langkah sebelumnya tanpa kehilangan pilihan', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await ready();
    await user.click(screen.getByRole('button', { name: /^gambar/i }));
    expect(stepButton('Gaya')).toHaveAttribute('aria-current', 'step');
    expect(stepButton('Prompt')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /tanpa preset/i }));
    await user.type(screen.getByLabelText(/subjek/i), 'perahu kertas');
    await user.click(screen.getByRole('radio', { name: '16:9' }));

    await user.click(stepButton('Jenis'));
    expect(screen.getByRole('button', { name: /^gambar/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /video 6 detik/i })).toHaveAttribute('aria-pressed', 'false');
    expect(stepButton('Prompt')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^lanjut/i }));
    await user.click(screen.getByRole('button', { name: /^lanjut/i }));
    expect(stepButton('Prompt')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText(/subjek/i)).toHaveValue('perahu kertas');
    expect(screen.getByRole('radio', { name: '16:9' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('combobox', { name: /durasi/i })).toBeNull();
  });

  it('tidak ada native select/radio/checkbox/date di setiap langkah', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await ready();
    noNativeControls();
    await user.click(screen.getByRole('button', { name: /video 6 detik/i }));
    noNativeControls();
    await user.click(screen.getByRole('button', { name: /tanpa preset/i }));
    noNativeControls();
    expect(screen.getByRole('combobox', { name: /durasi/i })).toHaveTextContent('6 detik');
    expect(screen.getByRole('combobox', { name: /kategori teknik/i })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /lihat hasil/i }));
    noNativeControls();
  });
});

describe('StudioPage — prompt', () => {
  it('memilih teknik lalu mengantrekan prompt tersusun ke Flow, lalu pindah ke Hasil', async () => {
    const user = userEvent.setup();
    let posted: unknown;
    const fetchImpl = makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]]);
    renderPage(fetchImpl);
    await ready();
    await toPrompt(user);
    await user.type(screen.getByLabelText(/subjek/i), 'perahu kertas');
    await user.click(screen.getByRole('button', { name: /tambah dolly in/i }));
    expect(screen.getByTestId('composed-prompt').textContent).toContain('The camera dollies toward perahu kertas.');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect(posted).toMatchObject({ prompt: expect.stringContaining('dollies toward perahu kertas'), technique: 'camera-movement/dolly-in', aspect: '9:16', durationSec: 6 });
    expect(posted).not.toHaveProperty('kind');
    await waitFor(() => expect(stepButton('Hasil')).toHaveAttribute('aria-current', 'step'));
    expect(screen.getByRole('status', { name: /pemberitahuan/i })).toHaveTextContent(/masuk antrean/i);
  });

  it('durasi lewat Choice dan rasio lewat Segmented ikut terkirim', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    renderPage(makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: doneJob }); }]]));
    await ready();
    await toPrompt(user);
    await user.type(screen.getByLabelText(/subjek/i), 'kapal');
    await user.click(screen.getByRole('combobox', { name: /durasi/i }));
    await user.click(await screen.findByRole('option', { name: '8 detik' }));
    await user.click(screen.getByRole('radio', { name: '16:9' }));
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect(posted).toMatchObject({ durationSec: 8, aspect: '16:9' });
  });

  it('jalur Gambar melewati pilihan durasi dan mengantrekan kind:image gratis', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    renderPage(makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: doneJob }); }]]));
    await ready();
    await toPrompt(user, /^gambar/i);
    expect(screen.queryByRole('combobox', { name: /durasi/i })).toBeNull();
    await user.type(screen.getByLabelText(/subjek/i), 'perahu kertas');
    const button = screen.getByRole('button', { name: /antrekan ke flow/i });
    expect(button.textContent).toMatch(/gratis/i);
    await user.click(button);
    expect(posted).toMatchObject({ kind: 'image', aspect: '9:16' });
    expect(String(posted?.prompt)).toMatch(/perahu kertas/i);
  });

  it('menyaring teknik dengan pencarian dan kategori', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await ready();
    await toPrompt(user);
    await user.type(screen.getByLabelText(/cari teknik/i), 'rim');
    expect(screen.queryByRole('button', { name: /tambah dolly in/i })).toBeNull();
    expect(screen.getByRole('button', { name: /tambah rim light/i })).toBeTruthy();
    await user.clear(screen.getByLabelText(/cari teknik/i));
    await user.click(screen.getByRole('combobox', { name: /kategori teknik/i }));
    await user.click(await screen.findByRole('option', { name: 'Gerak kamera' }));
    expect(screen.getByRole('button', { name: /tambah dolly in/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /tambah rim light/i })).toBeNull();
  });

  it('tombol antre mati sebelum ada subjek', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await ready();
    await toPrompt(user);
    expect(screen.getByRole('button', { name: /antrekan ke flow/i })).toBeDisabled();
  });

  it('menampilkan error server saat antre gagal', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch([[/\/api\/flow\/jobs$/, () => json({ error: { code: 'INVALID_INPUT', message: 'prompt is required' } }, 400)]]));
    await ready();
    await toPrompt(user);
    await user.type(screen.getByLabelText(/subjek/i), 'x');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('prompt is required');
    expect(stepButton('Prompt')).toHaveAttribute('aria-current', 'step');
  });
});

describe('StudioPage — hasil', () => {
  it('job selesai punya pemutar video; gambar tampil sebagai <img>; badge status', async () => {
    const user = userEvent.setup();
    const imageJob = { ...doneJob, id: 'job_bbbbbbbbbbbbbbbb', kind: 'image', prompt: 'mercusuar' };
    renderPage(makeFetch([], [doneJob, imageJob]));
    await ready();
    await user.click(screen.getByRole('button', { name: /lihat hasil/i }));
    expect(stepButton('Hasil')).toHaveAttribute('aria-current', 'step');
    const video = screen.getByTestId(`clip-${doneJob.id}`);
    expect(video.getAttribute('src')).toBe(`${BASE}/api/flow/jobs/${doneJob.id}/file`);
    const still = screen.getByRole('img', { name: /mercusuar/ });
    expect(still.getAttribute('src')).toBe(`${BASE}/api/flow/jobs/${imageJob.id}/file`);
    expect(screen.getAllByText('Selesai').length).toBe(2);
  });

  it('job gagal menampilkan sebab dan Coba lagi mengantrekan ulang prompt yang sama', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    const failed = { ...doneJob, id: 'job_cccccccccccccccc', status: 'failed', prompt: 'badai', error: 'Flow menolak prompt', aspect: '16:9', durationSec: 8, technique: 'preset:drama-confrontation' };
    renderPage(makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: doneJob }); }]], [failed]));
    await ready();
    await user.click(screen.getByRole('button', { name: /lihat hasil/i }));
    const item = screen.getByRole('listitem', { name: /badai/ });
    expect(item).toHaveTextContent('Gagal');
    expect(item).toHaveTextContent('Flow menolak prompt');
    await user.click(within(item).getByRole('button', { name: /coba lagi/i }));
    expect(posted).toEqual({ prompt: 'badai', aspect: '16:9', durationSec: 8, technique: 'preset:drama-confrontation' });
  });

  it('antrean kosong menjelaskan sebabnya dan satu aksi untuk mulai', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch([], []));
    await ready();
    await user.click(screen.getByRole('button', { name: /lihat hasil/i }));
    expect(screen.getByText(/belum ada hasil/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /buat yang pertama/i }));
    expect(stepButton('Jenis')).toHaveAttribute('aria-current', 'step');
  });
});

describe('StudioPage — gaya (preset)', () => {
  async function renderFull(fetchImpl: ReturnType<typeof vi.fn>) {
    const { default: catalog } = await import('./techniques.json', { with: { type: 'json' } });
    renderPage(fetchImpl, catalog as Technique[]);
    await ready();
  }

  it('galeri menampilkan preset dengan video contoh, filter grup, dan opsi Tanpa preset', async () => {
    const user = userEvent.setup();
    await renderFull(makeFetch());
    await user.click(screen.getByRole('button', { name: /video 6 detik/i }));
    const gallery = screen.getByRole('region', { name: /pilih gaya/i });
    expect(within(gallery).getByRole('button', { name: /tanpa preset/i })).toBeTruthy();
    const card = within(gallery).getByRole('article', { name: 'Dialog intim' });
    expect(card.querySelector('video')?.getAttribute('src')).toMatch(/^https:\/\/asset\.melies\.co\/.+\.mp4$/);
    await user.click(within(gallery).getByRole('tab', { name: /anak/i }));
    expect(within(gallery).queryByRole('article', { name: 'Dialog intim' })).toBeNull();
    expect(within(gallery).getByRole('article', { name: 'Animasi 3D lucu' })).toBeTruthy();
  });

  it('Pakai gaya ini mengisi composer, pindah ke Prompt, dan prompt lengkap ikut diantrekan', async () => {
    const user = userEvent.setup();
    let posted: { prompt: string; durationSec: number; technique: string } | undefined;
    await renderFull(makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]]));
    await user.click(screen.getByRole('button', { name: /video 6 detik/i }));
    await user.click(screen.getByRole('button', { name: 'Pakai gaya Dialog intim' }));
    expect(stepButton('Prompt')).toHaveAttribute('aria-current', 'step');
    expect((screen.getByLabelText(/karakter/i) as HTMLInputElement).value).toContain('cream knit sweater');
    expect((screen.getByLabelText(/subjek/i) as HTMLTextAreaElement).value).toContain('admits the truth');
    const prompt = screen.getByTestId('composed-prompt').textContent ?? '';
    expect(prompt.startsWith('Medium close-up of a woman')).toBe(true);
    expect(prompt).toContain('Style: naturalistic performance');
    expect(prompt).toContain('Negative prompt: subtitles, captions, on-screen text, watermark');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect(posted?.prompt).toBe(prompt);
    expect(posted?.durationSec).toBe(6);
    expect(posted?.technique).toBe('preset:drama-intimate-dialogue');
  });

  it('kembali ke Gaya menandai preset yang dipakai; Tanpa preset mengosongkan teknik preset', async () => {
    const user = userEvent.setup();
    await renderFull(makeFetch());
    await user.click(screen.getByRole('button', { name: /video 6 detik/i }));
    await user.click(screen.getByRole('button', { name: 'Pakai gaya Dialog intim' }));
    await user.click(stepButton('Gaya'));
    expect(within(screen.getByRole('article', { name: 'Dialog intim' })).getByText(/dipakai/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /tanpa preset/i }));
    expect(screen.queryByRole('list', { name: /teknik dipilih/i })).toBeNull();
    expect(screen.getByTestId('composed-prompt').textContent).not.toContain('Style: naturalistic');
  });

  it('memakai klip render Flow kita bila ada, dan memberi label sumber dengan jujur', async () => {
    const user = userEvent.setup();
    const own = { ...doneJob, id: 'job_bbbbbbbbbbbbbbbb', technique: 'preset:drama-intimate-dialogue', finishedAtMs: 5 };
    await renderFull(makeFetch([], [own]));
    await user.click(screen.getByRole('button', { name: /video 6 detik/i }));
    const card = screen.getByRole('article', { name: 'Dialog intim' });
    expect(card.querySelector('video')?.getAttribute('src')).toBe(`${BASE}/api/flow/jobs/${own.id}/file`);
    expect(within(card).getByText(/render flow/i)).toBeTruthy();
    const other = screen.getByRole('article', { name: 'Konfrontasi tegang' });
    expect(within(other).getByText(/contoh teknik · melies/i)).toBeTruthy();
  });

  it('Render contoh mengantrekan prompt preset itu sendiri, bukan isi composer', async () => {
    const user = userEvent.setup();
    let posted: { prompt: string; technique: string; durationSec: number } | undefined;
    await renderFull(makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]], []));
    await toPrompt(user);
    await user.type(screen.getByLabelText(/subjek/i), 'isi composer yang tidak boleh ikut');
    await user.click(stepButton('Gaya'));
    await user.click(screen.getByRole('button', { name: 'Render contoh Konfrontasi tegang' }));
    expect(posted?.technique).toBe('preset:drama-confrontation');
    expect(posted?.prompt).toContain('slams his palm on the table');
    expect(posted?.prompt).not.toContain('isi composer');
    expect(posted?.durationSec).toBe(4);
  });
});

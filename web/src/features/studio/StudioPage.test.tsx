import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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

function makeFetch(extra: Array<[RegExp, (init?: RequestInit) => Response]> = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    for (const [re, fn] of extra) if (re.test(url) && (init?.method ?? 'GET') !== 'GET') return fn(init);
    if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { bridgeId: 'mac', online: true, lastSeenMs: Date.now() } });
    if (url.endsWith('/api/flow/jobs')) return json({ jobs: [doneJob] });
    return json({}, 404);
  });
}

function renderPage(fetchImpl: ReturnType<typeof makeFetch>) {
  render(
      <StudioPage baseUrl={BASE} fetchImpl={fetchImpl as unknown as typeof fetch} techniques={techniques} />
  );
}

describe('StudioPage', () => {
  it('menampilkan KPI dari akun, antrean, dan status bridge', async () => {
    renderPage(makeFetch());
    const kpi = await screen.findByRole('region', { name: /ringkasan/i });
    expect(await within(kpi).findByText('103', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText(/bridge online/i)).toBeTruthy();
    expect(screen.getByText('Akun 1', { selector: 'strong' })).toBeTruthy();
  });

  it('memilih teknik lalu mengantrekan prompt tersusun ke Flow', async () => {
    const user = userEvent.setup();
    let posted: unknown;
    const fetchImpl = makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]]);
    renderPage(fetchImpl);
    await screen.findByText('Akun 1', { selector: 'strong' });
    await user.type(screen.getByLabelText(/subjek/i), 'perahu kertas');
    await user.click(screen.getByRole('button', { name: /tambah dolly in/i }));
    expect(screen.getByTestId('composed-prompt').textContent).toContain('The camera dollies toward perahu kertas.');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect(posted).toMatchObject({ prompt: expect.stringContaining('dollies toward perahu kertas'), technique: 'camera-movement/dolly-in', aspect: '9:16' });
  });

  it('menyaring teknik dengan pencarian', async () => {
    const user = userEvent.setup();
    renderPage(makeFetch());
    await screen.findByText('Akun 1', { selector: 'strong' });
    await user.type(screen.getByLabelText(/cari teknik/i), 'rim');
    expect(screen.queryByRole('button', { name: /tambah dolly in/i })).toBeNull();
    expect(screen.getByRole('button', { name: /tambah rim light/i })).toBeTruthy();
  });

  it('job selesai punya pemutar video dari endpoint file', async () => {
    renderPage(makeFetch());
    const video = await screen.findByTestId(`clip-${doneJob.id}`);
    expect(video.getAttribute('src')).toBe(`${BASE}/api/flow/jobs/${doneJob.id}/file`);
  });

  it('menambah akun Flow lewat form', async () => {
    const user = userEvent.setup();
    let posted: unknown;
    const fetchImpl = makeFetch([[/\/api\/flow\/accounts$/, init => { posted = JSON.parse(String(init?.body)); return json({ account: { ...account, id: 'acc_2', label: 'Akun 2' } }); }]]);
    renderPage(fetchImpl);
    await screen.findByText('Akun 1', { selector: 'strong' });
    await user.type(screen.getByLabelText(/label akun/i), 'Akun 2');
    await user.type(screen.getByLabelText(/email akun/i), 'b@c.d');
    await user.type(screen.getByLabelText(/folder profile/i), '/Users/x/.google-flow-mcp/profiles/acc-02');
    await user.click(screen.getByRole('button', { name: /tambah akun/i }));
    expect(posted).toMatchObject({ label: 'Akun 2', email: 'b@c.d', profileDir: '/Users/x/.google-flow-mcp/profiles/acc-02' });
  });

  it('menampilkan error server saat antre gagal', async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetch([[/\/api\/flow\/jobs$/, () => json({ error: { code: 'INVALID_INPUT', message: 'prompt is required' } }, 400)]]);
    renderPage(fetchImpl);
    await screen.findByText('Akun 1', { selector: 'strong' });
    await user.type(screen.getByLabelText(/subjek/i), 'x');
    await user.click(screen.getByRole('button', { name: /antrekan ke flow/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('prompt is required');
  });
});

describe('StudioPage preset gaya (clone)', () => {
  async function renderFull(fetchImpl: ReturnType<typeof makeFetch>) {
    const { default: catalog } = await import('./techniques.json', { with: { type: 'json' } });
    render(
        <StudioPage baseUrl={BASE} fetchImpl={fetchImpl as unknown as typeof fetch} techniques={catalog as Technique[]} />
    );
    await screen.findByText('Akun 1', { selector: 'strong' });
  }

  it('galeri menampilkan preset dengan video contoh dan filter grup', async () => {
    const user = userEvent.setup();
    await renderFull(makeFetch());
    const gallery = screen.getByRole('region', { name: /preset gaya/i });
    const card = within(gallery).getByRole('article', { name: 'Dialog intim' });
    expect(card.querySelector('video')?.getAttribute('src')).toMatch(/^https:\/\/asset\.melies\.co\/.+\.mp4$/);
    await user.click(within(gallery).getByRole('tab', { name: 'Anak' }));
    expect(within(gallery).queryByRole('article', { name: 'Dialog intim' })).toBeNull();
    expect(within(gallery).getByRole('article', { name: 'Animasi 3D lucu' })).toBeTruthy();
  });

  it('clone preset mengisi composer lalu prompt lengkap ikut diantrekan', async () => {
    const user = userEvent.setup();
    let posted: { prompt: string; durationSec: number; technique: string } | undefined;
    const fetchImpl = makeFetch([[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]]);
    await renderFull(fetchImpl);
    await user.click(screen.getByRole('button', { name: 'Clone Dialog intim' }));
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
});

describe('StudioPage preview preset buatan sendiri', () => {
  async function renderWithJobs(jobs: unknown[], extra: Array<[RegExp, (init?: RequestInit) => Response]> = []) {
    const { default: catalog } = await import('./techniques.json', { with: { type: 'json' } });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      for (const [re, fn] of extra) if (re.test(url) && (init?.method ?? 'GET') !== 'GET') return fn(init);
      if (url.endsWith('/api/flow/accounts')) return json({ accounts: [account], bridge: { online: true } });
      if (url.endsWith('/api/flow/jobs')) return json({ jobs });
      return json({}, 404);
    });
    render(
        <StudioPage baseUrl={BASE} fetchImpl={fetchImpl as unknown as typeof fetch} techniques={catalog as Technique[]} />
    );
    await screen.findByText('Akun 1', { selector: 'strong' });
  }

  it('memakai klip render Flow kita bila ada, dan memberi label sumber dengan jujur', async () => {
    const own = { ...doneJob, id: 'job_bbbbbbbbbbbbbbbb', technique: 'preset:drama-intimate-dialogue', finishedAtMs: 5 };
    await renderWithJobs([own]);
    const card = screen.getByRole('article', { name: 'Dialog intim' });
    expect(card.querySelector('video')?.getAttribute('src')).toBe(`${BASE}/api/flow/jobs/${own.id}/file`);
    expect(within(card).getByText(/render flow/i)).toBeTruthy();
    const other = screen.getByRole('article', { name: 'Konfrontasi tegang' });
    expect(within(other).getByText(/contoh teknik · melies/i)).toBeTruthy();
  });

  it('Render contoh mengantrekan prompt preset itu sendiri, bukan isi composer', async () => {
    const user = userEvent.setup();
    let posted: { prompt: string; technique: string; durationSec: number } | undefined;
    await renderWithJobs([], [[/\/api\/flow\/jobs$/, init => { posted = JSON.parse(String(init?.body)); return json({ job: { ...doneJob, status: 'queued' } }); }]]);
    await user.type(screen.getByLabelText(/subjek/i), 'isi composer yang tidak boleh ikut');
    await user.click(screen.getByRole('button', { name: 'Render contoh Konfrontasi tegang' }));
    expect(posted?.technique).toBe('preset:drama-confrontation');
    expect(posted?.prompt).toContain('slams his palm on the table');
    expect(posted?.prompt).not.toContain('isi composer');
    expect(posted?.durationSec).toBe(4);
  });
});

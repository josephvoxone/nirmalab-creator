/** The audit surfaces of the project page: the score badge on a shot card, the review dialog and the gate banner. */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import type { Story } from '../stories/storiesClient.js';

const audit = (score: number, issues: string[] = []) => ({
  score, dimensions: { sceneMatch: score, actionMatch: score, moodMatch: score, composition: score },
  issues, repair: score < 70 ? 'The wooden gate is missing: add a weathered wooden gate across the lower third.' : '',
  model: 'google/gemini-2.5-flash', atMs: 1_000, costUsd: 0.002, target: 'frame' as const
});

const ALL = ['done', 'done', 'done', 'done'];

function storyWith(over: Partial<Story> = {}, audits: Record<string, ReturnType<typeof audit> | undefined> = {}): Story {
  const base = storyFor(BOARD, ALL, ALL, { status: 'review', ...over });
  return { ...base, shots: base.shots.map(s => ({ ...s, ...(audits[s.id] ? { audit: audits[s.id] } : {}) })) } as Story;
}

const card = (id: string) => within(screen.getByRole('list', { name: /shot di scene/i })).getByRole('listitem', { name: new RegExp(`· ${id}$`) });
const badge = (id: string) => within(card(id)).getByLabelText(`Skor audit ${id}`);
const posted = (api: ReturnType<typeof fakeProjectApi>, path: string) => api.calls.some(c => c.method === 'POST' && c.url === `/api/stories/${ID}/${path}`);

describe('shot card audit badge', () => {
  it('shows the score, its band colour and the issues as a tooltip; a dash when unaudited', async () => {
    mountProject(<ProjectPage pollMs={0} />, fakeProjectApi({
      story: storyWith({}, {
        '00-pembuka': audit(88),
        '01-pagar': audit(62, ['the wooden gate is missing', 'the cat is cropped at the edge']),
        '02-jalan': audit(41)
      })
    }).fetchImpl);

    await screen.findByRole('list', { name: /shot di scene/i });
    expect(badge('00-pembuka')).toHaveTextContent('88');
    expect(badge('00-pembuka').getAttribute('data-audit')).toBe('pass');
    expect(badge('01-pagar')).toHaveTextContent('62');
    expect(badge('01-pagar').getAttribute('data-audit')).toBe('warn');
    expect(badge('01-pagar')).toHaveAttribute('title', 'the wooden gate is missing; the cat is cropped at the edge');
    // the second scene has its own cards
    await userEvent.click(within(screen.getByRole('list', { name: /daftar scene/i })).getByRole('button', { name: 'Pilih Pulang' }));
    expect(badge('02-jalan')).toHaveTextContent('41');
    expect(badge('02-jalan').getAttribute('data-audit')).toBe('fail');
    expect(badge('03-peluk')).toHaveTextContent('—');
    expect(badge('03-peluk').getAttribute('data-audit')).toBe('none');
    expect(badge('03-peluk')).toHaveAttribute('title', 'Belum diaudit');
    // compact: the badge adds no native form control
    expect(card('03-peluk').querySelectorAll('select, input, textarea').length).toBe(0);
  });
});

describe('Hasil tab audit review', () => {
  const open = (story: Story) => {
    const api = fakeProjectApi({ story });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=hasil` });
    return api;
  };

  it('one line names how many shots need a look; the dialog lists them with the issues', async () => {
    open(storyWith({}, { '01-pagar': audit(62, ['the wooden gate is missing']) }));
    expect(await screen.findByText(/1 shot perlu dicek/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /periksa/i }));
    const dialog = await screen.findByRole('dialog', { name: /shot perlu dicek/i });
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('01-pagar');
    expect(rows[0]).toHaveTextContent('62');
    expect(rows[0]).toHaveTextContent(/wooden gate is missing/i);
    expect(within(rows[0]!).getByRole('button', { name: /^repair$/i })).toBeEnabled();
    expect(within(rows[0]!).getByRole('button', { name: /^setujui$/i })).toBeEnabled();
  });

  it('Setujui signs off the shot and the line disappears', async () => {
    const api = open(storyWith({}, { '01-pagar': audit(62, ['the wooden gate is missing']) }));
    await userEvent.click(await screen.findByRole('button', { name: /periksa/i }));
    const dialog = await screen.findByRole('dialog', { name: /shot perlu dicek/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /^setujui$/i }));
    await waitFor(() => expect(posted(api, 'shots/01-pagar/approve-audit')).toBe(true));
    await waitFor(() => expect(screen.queryByText(/shot perlu dicek — belum lolos audit/i)).toBeNull());
  });

  it('Repair sends the shot back with the audit instruction', async () => {
    const api = open(storyWith({}, { '01-pagar': audit(62, ['the wooden gate is missing']) }));
    await userEvent.click(await screen.findByRole('button', { name: /periksa/i }));
    const dialog = await screen.findByRole('dialog', { name: /shot perlu dicek/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /^repair$/i }));
    await waitFor(() => expect(posted(api, 'shots/01-pagar/repair')).toBe(true));
  });

  it('a passing and an unaudited project shows no audit line', async () => {
    open(storyWith({}, { '01-pagar': audit(88) }));
    await screen.findByRole('tabpanel');
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveTextContent(/shot|klip/i));
    expect(screen.queryByText(/perlu dicek/i)).toBeNull();
  });

  it('repair is disabled when the audit wrote no instruction', async () => {
    open(storyWith({}, { '01-pagar': { ...audit(62), repair: '' } }));
    await userEvent.click(await screen.findByRole('button', { name: /periksa/i }));
    const dialog = await screen.findByRole('dialog', { name: /shot perlu dicek/i });
    expect(within(dialog).getByRole('button', { name: /^repair$/i })).toBeDisabled();
  });
});

describe('gate banner', () => {
  it('shows the server message in the usual banner slot', async () => {
    const message = 'Belum bisa dirakit — audit belum lolos: 01-pagar (skor 62). Perbaiki atau setujui dulu di tab Hasil.';
    mountProject(<ProjectPage pollMs={0} />, fakeProjectApi({
      story: storyWith({ gate: { message, shots: [{ id: '01-pagar', score: 62, needsReview: false }] } })
    }).fetchImpl);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/belum bisa dirakit/i);
    expect(banner).toHaveTextContent(/01-pagar/);
  });
});

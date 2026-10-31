/** Motion QC on the project page: the chip on a shot card, the panel in the shot sheet (all its states), the review dialog. */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../stories/testCatalog.js';
import type { ShotMotion, Story } from '../stories/storiesClient.js';
import { ProjectPage } from './ProjectPage.js';
import { ShotSheet } from './ShotSheet.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import { ProjectProvider, useProjectState } from './useProject.js';

const mo = (over: Partial<ShotMotion> = {}): ShotMotion => ({ status: 'fail', score: 38, reasons: ['Gambar berganti/melebur sendiri di detik 1.7 (adegan atau karakter digambar ulang di tengah klip)'], at: 100, ...over });
const ALL = ['done', 'done', 'done', 'done'];

function storyWith(motion: Record<string, ShotMotion | undefined>, over: Partial<Story> = {}, clips = ALL): Story {
  const base = storyFor(BOARD, ALL, clips, { status: 'review', ...over });
  return { ...base, shots: base.shots.map(s => ({ ...s, jobId: `job-${s.id}`, ...(motion[s.id] ? { motion: motion[s.id], motionJobId: `job-${s.id}` } : {}) })) } as Story;
}

function Harness(props: { shotId: string }) {
  const { id = '' } = useParams();
  const p = useProjectState(id, 0);
  if (!p.board || !p.story) return <p>memuat</p>;
  return <ProjectProvider value={p}><ShotSheet shotId={props.shotId} catalog={CATALOG} onClose={() => undefined} /></ProjectProvider>;
}
async function sheet(story: Story, shotId = '01-pagar') {
  const api = fakeProjectApi({ story });
  mountProject(<Harness shotId={shotId} />, api.fetchImpl);
  const dialog = await screen.findByRole('dialog', { name: new RegExp(`· ${shotId}$`) });
  return { api, dialog };
}
const panel = (dialog: HTMLElement) => within(dialog).getByRole('region', { name: /cek gerak klip/i });

describe('shot card chip', () => {
  const card = (id: string) => within(screen.getByRole('list', { name: /shot di scene/i })).getByRole('listitem', { name: new RegExp(`· ${id}$`) });
  it('shows a chip only for a warn or a fail, with the reasons as its tooltip; nothing for ok or unchecked', async () => {
    mountProject(<ProjectPage pollMs={0} />, fakeProjectApi({
      story: storyWith({ '00-pembuka': mo({ status: 'ok', score: 100, reasons: [] }), '01-pagar': mo({ status: 'warn', score: 72, reasons: ['Hampir tidak ada gerak (klip seperti gambar diam)'] }) })
    }).fetchImpl);
    await screen.findByRole('list', { name: /shot di scene/i });
    expect(within(card('01-pagar')).getByLabelText('Cek gerak 01-pagar')).toHaveAttribute('data-motion', 'warn');
    expect(within(card('01-pagar')).getByLabelText('Cek gerak 01-pagar')).toHaveAttribute('title', 'Hampir tidak ada gerak (klip seperti gambar diam)');
    expect(within(card('00-pembuka')).queryByLabelText('Cek gerak 00-pembuka')).toBeNull();
  });
  it('a fail is red-toned', async () => {
    mountProject(<ProjectPage pollMs={0} />, fakeProjectApi({ story: storyWith({ '01-pagar': mo() }) }).fetchImpl);
    await screen.findByRole('list', { name: /shot di scene/i });
    expect(within(card('01-pagar')).getByLabelText('Cek gerak 01-pagar')).toHaveAttribute('data-motion', 'fail');
  });
});

describe('shot sheet panel', () => {
  it('fail: says it needs a look, lists the reasons, the free fixes, and the limit — with no button that renders or spends', async () => {
    const { dialog } = await sheet(storyWith({ '01-pagar': mo({ suggest: { trimOut: 3.4 } }) }));
    const p = panel(dialog);
    expect(p).toHaveTextContent(/perlu dicek/i);
    expect(p).toHaveTextContent(/melebur sendiri di detik 1\.7/);
    expect(p).toHaveTextContent('Potong akhir klip di detik 3,4');
    expect(p).toHaveTextContent(/tudung/i);                       // the limit is stated
    expect(within(p).queryAllByRole('button')).toHaveLength(0);   // no action here: nothing can cost credits from this panel
    expect(p.textContent).not.toMatch(/render ulang\s*·|kredit\s*\d|\d+\s*kredit/i);
  });
  it('warn: a note, not an alarm', async () => {
    const { dialog } = await sheet(storyWith({ '01-pagar': mo({ status: 'warn', score: 72, reasons: ['Hampir tidak ada gerak (klip seperti gambar diam)'] }) }));
    expect(panel(dialog)).toHaveTextContent(/catatan/i);
    expect(panel(dialog)).toHaveTextContent(/gambar diam/);
    expect(panel(dialog)).not.toHaveTextContent(/perlu dicek/i);
  });
  it('ok: says no problem was found, and still states the limit', async () => {
    const { dialog } = await sheet(storyWith({ '01-pagar': mo({ status: 'ok', score: 100, reasons: [] }) }));
    expect(panel(dialog)).toHaveTextContent(/tidak ada masalah gerak/i);
    expect(panel(dialog)).toHaveTextContent(/tidak terdeteksi/i);
  });
  it('empty: the clip is done but has no verdict yet', async () => {
    const { dialog } = await sheet(storyWith({}));
    expect(panel(dialog)).toHaveTextContent(/belum diperiksa/i);
  });
  it('loading: the clip is still being made', async () => {
    const { dialog } = await sheet(storyWith({}, {}, ['done', 'queued', 'done', 'done']));
    expect(panel(dialog)).toHaveTextContent(/menunggu klip selesai/i);
  });
  it('error: the server logged that the check could not run', async () => {
    const { dialog } = await sheet(storyWith({}, { events: [{ atMs: 5, message: 'Cek gerak 01-pagar dilewati: tidak bisa dijalankan (klip tetap dipakai)' }] }));
    expect(panel(dialog)).toHaveTextContent(/tidak bisa dijalankan/i);
    expect(panel(dialog)).toHaveTextContent(/klip tetap bisa dipakai/i);
  });
  it('a shot without a clip shows no panel at all', async () => {
    const { dialog } = await sheet(storyWith({}, {}, ['pending', 'pending', 'pending', 'pending']));
    expect(within(dialog).queryByRole('region', { name: /cek gerak klip/i })).toBeNull();
  });
  it('adds no native form control', async () => {
    const { dialog } = await sheet(storyWith({ '01-pagar': mo() }));
    expect(panel(dialog).querySelectorAll('select, input, textarea, [type=checkbox], [type=radio]').length).toBe(0);
  });
});

describe('Hasil tab review dialog', () => {
  it('lists a motion-flagged shot with its reason; Setujui signs it off', async () => {
    const story = storyWith({ '01-pagar': mo() });
    story.shots = story.shots.map(s => (s.id === '01-pagar' ? { ...s, needsReview: true, motionReview: true } : s)) as Story['shots'];
    const api = fakeProjectApi({ story });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=hasil` });
    expect(await screen.findByText(/1 shot perlu dicek/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /periksa/i }));
    const dialog = await screen.findByRole('dialog', { name: /shot perlu dicek/i });
    const row = within(dialog).getAllByRole('listitem')[0]!;
    expect(row).toHaveTextContent('01-pagar');
    expect(row).toHaveTextContent(/melebur sendiri di detik 1\.7/);
    expect(within(row).getByRole('button', { name: /^repair$/i })).toBeDisabled();       // no paid instruction for a motion flag
    await userEvent.click(within(row).getByRole('button', { name: /^setujui$/i }));
    await waitFor(() => expect(api.calls.some(c => c.method === 'POST' && c.url === `/api/stories/${ID}/shots/01-pagar/approve-audit`)).toBe(true));
  });
});

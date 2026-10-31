import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';

const ALL = ['done', 'done', 'done', 'done'];
const open = (extra: Record<string, unknown>) => mountProject(<ProjectPage pollMs={0} />, fakeProjectApi({ story: storyFor(BOARD, ALL, ALL, { status: 'done', video: { bytes: 2_000_000, finishedAtMs: 5 }, ...extra }) }).fetchImpl, { path: `/cerita/${ID}?tab=hasil` });

describe('Hasil tab: the last assembly warned about silent shots', () => {
  it('names the shots whose dub was not fresh, and where to fix it', async () => {
    open({ warnings: ['dub-basi:01-pagar', 'dub-basi:03-peluk'] });
    const note = await screen.findByText(/tanpa suara dub/i);
    expect(note).toHaveTextContent(/01-pagar/);
    expect(note).toHaveTextContent(/03-peluk/);
    expect(note).toHaveTextContent(/tab dubbing/i);
  });
  it('no warnings, no note', async () => {
    open({});
    await screen.findByLabelText('Video akhir');
    expect(screen.queryByText(/tanpa suara dub/i)).toBeNull();
  });
});

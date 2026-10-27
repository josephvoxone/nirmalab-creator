import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../stories/testCatalog.js';
import { ProjectPage } from './ProjectPage.js';
import { ShotSheet } from './ShotSheet.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor } from './testkit.js';
import { ProjectProvider, useProjectState } from './useProject.js';

type Api = ReturnType<typeof fakeProjectApi>;
const puts = (api: Api) => api.calls.filter(c => c.method === 'PUT');
const gets = (api: Api) => api.calls.filter(c => c.method === 'GET' && c.url === `/api/stories/${ID}`);
const BANNER = 'Proyek baru diubah di tempat lain — dimuat ulang';

/** What the assistant does between the tab's read and its save: a new revision with other content. */
function assistantEdits(api: Api, title = 'Judul dari asisten') {
  api.board = { ...api.board, title };
  api.story = { ...api.story, title, rev: (api.story.rev ?? 1) + 1 };
}

async function renameProject(text: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Ubah judul' }));
  const input = screen.getByRole('textbox', { name: 'Judul proyek' });
  await userEvent.clear(input);
  await userEvent.type(input, `${text}{Enter}`);
}

afterEach(() => { vi.useRealTimers(); });

describe('useProject — revisions', () => {
  it('sends the rev it read with every PUT, and the new rev after a save', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 3 }) });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await renameProject('Jingga Pulang');
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]!.body).toMatchObject({ rev: 3 });
    await renameProject('Jingga Pulang Lagi');
    await waitFor(() => expect(puts(api)).toHaveLength(2));
    expect(puts(api)[1]!.body).toMatchObject({ rev: 4 });
  });

  it('409 STALE: refetches, keeps the assistant change and shows ONE banner that goes away after 6 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 3 }) });
    mountProject(<ProjectPage pollMs={0} />, api.fetchImpl);
    await screen.findByRole('heading', { name: BOARD.title });
    const before = gets(api).length;
    assistantEdits(api);
    await renameProject('Judul saya');
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    await waitFor(() => expect(gets(api).length).toBeGreaterThan(before));
    expect(await screen.findByRole('heading', { name: 'Judul dari asisten' })).toBeInTheDocument();
    expect(screen.getAllByText(BANNER)).toHaveLength(1);
    // The refusal is not an error banner on top of the notice.
    expect(screen.queryByText(/perubahan tidak tersimpan/i)).toBeNull();
    expect(api.board.title).toBe('Judul dari asisten');
    act(() => { vi.advanceTimersByTime(6100); });
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
  });
});

function Harness(props: { shotId: string }) {
  const { id = '' } = useParams();
  const p = useProjectState(id, 0);
  if (!p.board || !p.story) return <p>memuat</p>;
  return (
    <ProjectProvider value={p}>
      {p.notice && <p role="status">{p.notice}</p>}
      <ShotSheet shotId={props.shotId} catalog={CATALOG} onClose={() => undefined} />
    </ProjectProvider>
  );
}

describe('ShotSheet — stale save', () => {
  it('keeps the unsaved narration after a 409, says so, and saves with the new rev on the next try', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 5 }) });
    mountProject(<Harness shotId="01-pagar" />, api.fetchImpl);
    const sheet = await screen.findByRole('dialog', { name: /01-pagar$/ });
    const narration = within(sheet).getByRole('textbox', { name: 'Narasi' });
    await userEvent.clear(narration);
    await userEvent.type(narration, 'Jingga tetap menunggu.');
    assistantEdits(api);
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(await within(sheet).findByText('Perubahanmu belum tersimpan — simpan lagi')).toBeInTheDocument();
    await waitFor(() => expect(api.calls.filter(c => c.method === 'GET' && c.url === `/api/stories/${ID}`).length).toBeGreaterThan(1));
    expect(narration).toHaveValue('Jingga tetap menunggu.');
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(puts(api)).toHaveLength(2));
    expect(puts(api)[1]!.body).toMatchObject({ rev: 6 });
    expect(api.board.shots[1]!.narration).toBe('Jingga tetap menunggu.');
    await waitFor(() => expect(within(sheet).queryByText('Perubahanmu belum tersimpan — simpan lagi')).toBeNull());
  });
});

describe('ShotSheet — after a STALE reload only the fields the user changed are saved', () => {
  it('the assistant\'s new prompt for the same shot survives; the user\'s narration is saved on top', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 5 }) });
    mountProject(<Harness shotId="01-pagar" />, api.fetchImpl);
    const sheet = await screen.findByRole('dialog', { name: /01-pagar$/ });
    const narration = within(sheet).getByRole('textbox', { name: 'Narasi' });
    await userEvent.clear(narration);
    await userEvent.type(narration, 'Jingga tetap menunggu.');
    // The assistant rewrites this shot's prompt meanwhile.
    const PROMPT = 'Close-up, the camera pushes in slowly. JINGGA lifts her head toward the road.';
    api.board = { ...api.board, shots: api.board.shots.map(s => (s.id === '01-pagar' ? { ...s, prompt: PROMPT } : s)) };
    api.story = { ...api.story, rev: 6 };
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    expect(await within(sheet).findByText('Perubahanmu belum tersimpan — simpan lagi')).toBeInTheDocument();
    // The fresh board shows the assistant's prompt in the field the user never touched.
    await waitFor(() => expect(within(sheet).getByRole('textbox', { name: /prompt \(english\)/i })).toHaveValue(PROMPT));
    expect(narration).toHaveValue('Jingga tetap menunggu.');
    await userEvent.click(within(sheet).getByRole('button', { name: /^simpan$/i }));
    await waitFor(() => expect(puts(api)).toHaveLength(2));
    const shot = (puts(api)[1]!.body!.storyboard as typeof BOARD).shots.find(s => s.id === '01-pagar')!;
    expect(shot).toMatchObject({ prompt: PROMPT, narration: 'Jingga tetap menunggu.' });
    expect(api.board.shots.find(s => s.id === '01-pagar')).toMatchObject({ prompt: PROMPT, narration: 'Jingga tetap menunggu.' });
  });
});

describe('useProject — quick successive saves', () => {
  it('sends the second save with the rev the first one returned (no false STALE)', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 7 }) });
    let save!: ReturnType<typeof useProjectState>['save'];
    let board!: ReturnType<typeof useProjectState>['board'];
    function Grab() { const { id = '' } = useParams(); const p = useProjectState(id, 0); save = p.save; board = p.board; return <p>{p.notice ?? 'ok'}</p>; }
    mountProject(<Grab />, api.fetchImpl);
    await waitFor(() => expect(board).toBeTruthy());
    await act(async () => { await Promise.all([save({ ...board!, title: 'Satu' }), save({ ...board!, title: 'Dua' })]); });
    expect(puts(api).map(c => c.body!.rev)).toEqual([7, 8]);
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});

// ------------------------------------------------------------------ base revisions (review fix round 1)

type P = ReturnType<typeof useProjectState>;

/** The hook mounted bare: `now` is the latest render, `first` the first render that had a board. */
function mountHook(api: Api) {
  const seen: { now?: P; first?: P } = {};
  function Grab() {
    const { id = '' } = useParams();
    const p = useProjectState(id, 0);
    seen.now = p;
    if (!seen.first && p.board) seen.first = p;
    return <p>{p.notice ?? 'ok'}</p>;
  }
  mountProject(<Grab />, api.fetchImpl);
  return seen;
}

describe('useProject — every save carries the rev of the board it was built from', () => {
  it('a save built from a board read before the assistant changed it is refused (STALE), even after a reload', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 3 }) });
    const seen = mountHook(api);
    await waitFor(() => expect(seen.first).toBeTruthy());
    assistantEdits(api);
    act(() => seen.now!.reload());
    await waitFor(() => expect(seen.now!.board!.title).toBe('Judul dari asisten'));
    // An editor that read the board before the assistant's change saves on top of it.
    const old = seen.first!;
    let ok: boolean | undefined;
    await act(async () => { ok = await old.save({ ...old.board!, title: 'Judul lama saya' }); });
    expect(ok).toBe(false);
    expect(puts(api).map(c => c.body!.rev)).toEqual([3]);
    expect(api.board.title).toBe('Judul dari asisten');
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
  });

  it('an updater save runs on the latest board with its rev', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 3 }) });
    const seen = mountHook(api);
    await waitFor(() => expect(seen.first).toBeTruthy());
    assistantEdits(api);
    act(() => seen.now!.reload());
    await waitFor(() => expect(seen.now!.board!.title).toBe('Judul dari asisten'));
    await act(async () => { await seen.first!.save(latest => ({ ...latest, logline: 'Logline baru' })); });
    expect(puts(api).map(c => c.body!.rev)).toEqual([4]);
    expect(api.board).toMatchObject({ title: 'Judul dari asisten', logline: 'Logline baru' });
  });

  it('a breakdown applied between two queued saves is never deleted by the second save', async () => {
    const api = fakeProjectApi({ story: storyFor(BOARD, [], [], { rev: 7 }) });
    // The first PUT is stored by the server at once, but its answer is held back.
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const inner = api.fetchImpl;
    let first = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const res = await inner(url, init);
      if (init?.method === 'PUT' && first) { first = false; await held; }
      return res;
    });
    const seen: { now?: P } = {};
    function Grab() { const { id = '' } = useParams(); const p = useProjectState(id, 0); seen.now = p; return <p>{p.notice ?? 'ok'}</p>; }
    mountProject(<Grab />, fetchImpl as unknown as Api['fetchImpl']);
    await waitFor(() => expect(seen.now?.board).toBeTruthy());
    const p = seen.now!;
    let done!: Promise<boolean[]>;
    act(() => { done = Promise.all([p.save({ ...p.board!, title: 'Satu' }), p.save({ ...p.board!, title: 'Dua' })]); });
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    // The AI planner adds a shot on the server (rev 8 → 9) and its answer lands in the tab.
    api.board = { ...api.board, shots: [...api.board.shots, { id: 'ai-1', prompt: 'Wide shot, the camera stays still. A storm.' }] };
    api.story = { ...api.story, rev: (api.story.rev ?? 0) + 1, shots: [...api.story.shots, { id: 'ai-1', status: 'pending', attempts: 0 }] };
    act(() => seen.now!.apply({ story: api.story, storyboard: api.board as never }));
    release();
    await act(async () => { await done; });
    expect(puts(api).map(c => c.body!.rev)).toEqual([7, 8]);
    expect(api.board.shots.map(s => s.id)).toContain('ai-1');
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    await waitFor(() => expect(seen.now!.board!.shots.map(s => s.id)).toContain('ai-1'));
  });
});

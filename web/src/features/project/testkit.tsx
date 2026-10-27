/** Stateful fake of the stories API for project tests. Mirrors the contract in docs/production-model.md. */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { SessionContext } from '../../lib/session.js';
import type { Story } from '../stories/storiesClient.js';
import { normalizeScenes, type Board } from './model.js';
import { CATALOG } from '../stories/testCatalog.js';

export const ID = 'story_0123456789abcdef';

export const BOARD: Board = normalizeScenes({
  title: 'Jingga di Pagar', logline: 'Kucing oranye menunggu pemiliknya pulang.', mode: 'konsisten', aspect: '9:16',
  look: { style: 'storybook', genre: 'drama', era: 'auto', camera: 'auto', lens: 'auto', aperture: 'auto', palette: 'senja', lighting: 'auto', tempo: 'mengalir' },
  characters: { JINGGA: { name: 'Jingga', look: 'an orange tabby cat with a faded red collar' }, BIMA: 'a ten year old boy in a blue school uniform' },
  locations: { PAGAR: { name: 'Pagar rumah', look: 'a weathered wooden gate in a quiet village at dusk' }, JALAN: { name: 'Jalan desa', look: 'a dusty village road lined with banana trees' } },
  scenes: [
    { id: 'menunggu', title: 'Menunggu', summary: 'Jingga menunggu di pagar.', location: 'PAGAR', shots: ['00-pembuka', '01-pagar'] },
    { id: 'pulang', title: 'Pulang', summary: 'Bima kembali.', location: 'JALAN', shots: ['02-jalan', '03-peluk'] }
  ],
  shots: [
    { id: '00-pembuka', prompt: 'Wide shot, the camera stays still. A village at dusk.', silent: true },
    { id: '01-pagar', prompt: 'Medium shot, the camera stays still. JINGGA sits by the gate.', narration: 'Jingga menunggu setiap sore.' },
    { id: '02-jalan', prompt: 'Wide shot, the camera pushes in slowly. BIMA walks home.', narration: 'Suatu hari Bima pulang.' },
    { id: '03-peluk', prompt: 'Close-up, the camera stays still. BIMA hugs JINGGA.', narration: 'Mereka bertemu lagi.' }
  ]
});

const take = (status: string, extra: Record<string, unknown> = {}) => ({ status, attempts: 0, ...extra });

/** The bible of BOARD: two characters with anchors, both locations, a goal per scene. */
export const BIBLE = {
  logline: 'Kucing oranye menunggu pemiliknya pulang.', theme: 'kesetiaan', tone: 'hangat', audience: 'umum',
  structure: [{ act: 'hook', goal: 'Jingga sendirian' }, { act: 'setup', goal: 'menunggu' }, { act: 'turn', goal: 'hujan' }, { act: 'payoff', goal: 'Bima pulang' }],
  characters: [
    { token: 'JINGGA', name: 'Jingga', anchors: ['bulu oranye belang', 'kalung kulit merah pudar'], want: 'menunggu pemiliknya', need: 'berani pergi', arc: 'dari diam jadi bergerak' },
    { token: 'BIMA', name: 'Bima', anchors: ['seragam sekolah biru'], want: 'pulang', need: 'dimaafkan', arc: 'dari ragu jadi yakin' }
  ],
  locations: [
    { key: 'PAGAR', name: 'Pagar rumah', lookdev: 'a weathered wooden gate in a quiet village at dusk' },
    { key: 'JALAN', name: 'Jalan desa', lookdev: 'a dusty village road lined with banana trees' }
  ],
  scenes: [{ id: 'menunggu', title: 'Menunggu', goal: 'Kesetiaan Jingga', location: 'PAGAR' }, { id: 'pulang', title: 'Pulang', goal: 'Bima kembali', location: 'JALAN' }]
};

/** BOARD with a bible: shots 01 and 03 carry an intent, 00 and 02 are still prose. */
export function bibleBoard(): Board {
  return normalizeScenes({
    ...BOARD,
    bible: BIBLE,
    shots: BOARD.shots.map(s => {
      if (s.id === '01-pagar') return { ...s, intent: { subject: 'JINGGA', action: 'sits by the gate', startState: 'tail curled around the paws', endState: 'ears up toward the road', emotion: 'sabar', framing: 'medium', move: 'static' } };
      if (s.id === '03-peluk') return { ...s, intent: { subject: 'BIMA', action: 'hugs JINGGA', startState: 'arms open', endState: 'cat held close', framing: 'close-up' } };
      return s;
    })
  });
}

/** compile-shot like the server: prompts from the intent, a mandatory-slot issue for each empty slot. */
export const compileRoute: ExtraRoute = (call, json) => {
  if (!call.url.endsWith('/compile-shot')) return undefined;
  const shot = call.body?.shot as { id: string; intent?: Record<string, string> };
  const i = shot.intent ?? {};
  const issues = ['subject', 'action', 'startState', 'endState'].filter(k => !i[k]?.trim()).map(k => `shot ${shot.id}: mandatory slot ${k} is empty`);
  if (issues.length) return json(200, { imagePrompt: '', videoPrompt: '', issues, warnings: [] });
  return json(200, { imagePrompt: `Keyframe: ${i.subject} ${i.startState}.`, videoPrompt: `${i.framing ?? 'medium'} · ${i.subject} ${i.action}, ${i.startState} → ${i.endState}.`, issues: [], warnings: [] });
};

export function storyFor(board: Board, frames: string[] = [], clips: string[] = [], over: Partial<Story> = {}): Story {
  return {
    id: ID, title: board.title, status: 'review', mode: 'konsisten', createdAtMs: 1, updatedAtMs: 2, events: [{ atMs: 2, message: 'Keyframe siap untuk direview' }],
    cast: [{ token: 'JINGGA', name: 'Jingga', ...take('done') }, { token: 'BIMA', name: 'Bima', ...take('done') }],
    shots: board.shots.map((s, i) => ({ id: s.id, status: (clips[i] ?? 'pending') as 'pending', attempts: 0, frame: take(frames[i] ?? 'done', { mediaId: `m${i}` }) as never })),
    ...over
  } as Story;
}

export type Call = { method: string; url: string; body?: Record<string, unknown>; raw?: unknown; headers?: Record<string, string> };

/** A route the test answers itself (compile-shot, breakdown, uploads…); `undefined` falls through to the fake. */
export type ExtraRoute = (call: Call, json: (status: number, body: unknown) => Response) => Response | Promise<Response | undefined> | undefined;

export function fakeProjectApi(opts: {
  board?: Board; story?: Story; fail?: Partial<Record<'get' | 'put' | 'render' | 'prepare' | 'assemble', { status: number; message: string; code?: string }>>;
  extra?: ExtraRoute;
} = {}) {
  let board = opts.board ?? BOARD;
  let story = opts.story ?? storyFor(board);
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failWith = (k: keyof NonNullable<typeof opts.fail>) => {
    const f = opts.fail?.[k];
    return f ? json(f.status, { error: { message: f.message, code: f.code } }) : undefined;
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = { method, url, body, raw: init?.body, headers: init?.headers as Record<string, string> | undefined };
    calls.push(call);
    const own = await opts.extra?.(call, json);
    if (own) return own;
    if (url === '/api/stories/catalog') return json(200, { catalog: CATALOG, covers: {} });
    if (url === '/api/stories') return json(200, { stories: [story] });
    if (url === `/api/stories/${ID}` && method === 'GET') return failWith('get') ?? json(200, { story, storyboard: board });
    if (url === `/api/stories/${ID}` && method === 'PUT') {
      const f = failWith('put'); if (f) return f;
      // Revisions like the server: a client that sends the rev it read gets 409 STALE on a mismatch.
      if (body.rev !== undefined && story.rev !== undefined && body.rev !== story.rev) {
        return json(409, { error: { code: 'STALE', message: 'Proyek baru diubah di tempat lain — muat ulang.' } });
      }
      if (story.rev !== undefined) story = { ...story, rev: story.rev + 1 };
      board = normalizeScenes(body.storyboard);
      const old = new Map(story.shots.map(s => [s.id, s]));
      const wasOrder = story.shots.map(s => s.id).join();
      story = { ...story, title: board.title, shots: board.shots.map(s => old.get(s.id) ?? { id: s.id, status: 'pending', attempts: 0, frame: { status: 'pending', attempts: 0 } }) } as Story;
      if (story.video && wasOrder !== story.shots.map(s => s.id).join()) story = { ...story, videoStale: true, status: 'review' };
      return json(200, { story });
    }
    if (url === `/api/stories/${ID}/prepare`) return failWith('prepare') ?? json(200, { story: (story = { ...story, status: 'framing' }) });
    if (url === `/api/stories/${ID}/render`) return failWith('render') ?? json(200, { story: (story = { ...story, status: 'rendering' }) });
    if (url === `/api/stories/${ID}/assemble`) return failWith('assemble') ?? json(200, { story: (story = { ...story, status: 'assembling' }) });
    if (url.startsWith(`/api/stories/${ID}/shots/`) && url.endsWith('/frame') && method === 'POST') return json(200, { story: (story = { ...story, status: 'framing' }) });
    if (url === `/api/stories/${ID}/retry`) return json(200, { story: (story = { ...story, status: 'rendering' }) });
    if (url === `/api/stories/${ID}/look`) return json(200, { story });
    // Audit actions: repair puts the shot back in flight, approve clears the flag and the gate.
    const auditAction = new RegExp(`^/api/stories/${ID}/shots/([^/]+)/(repair|approve-audit)$`).exec(url);
    if (auditAction && method === 'POST') {
      const [, shotId, action] = auditAction;
      const repaired = action === 'repair';
      story = {
        ...story,
        ...(repaired ? { status: 'rendering' as const } : {}),
        ...(repaired ? {} : { gate: undefined }),
        shots: story.shots.map(s => (s.id === shotId
          ? { ...s, needsReview: undefined, ...(repaired ? { status: 'queued' as const } : { approvedBy: 'u1', approvedAtMs: Date.now() }) }
          : s))
      };
      return json(200, { story });
    }
    return json(404, { error: { message: `no fake for ${method} ${url}` } });
  });
  return {
    fetchImpl, calls,
    get board() { return board; }, set board(b: Board) { board = b; },
    get story() { return story; }, set story(s: Story) { story = s; }
  };
}

export function mountProject(ui: ReactNode, fetchImpl: ReturnType<typeof fakeProjectApi>['fetchImpl'], opts: { path?: string; isAdmin?: boolean } = {}) {
  return render(
    <SessionContext.Provider value={{ user: { id: 'u1', email: 'a@x.io', isAdmin: opts.isAdmin ?? true }, fetchImpl, signOut: async () => undefined }}>
      <MemoryRouter initialEntries={[opts.path ?? `/cerita/${ID}`]}>
        <Routes>
          <Route path="/cerita/:id" element={ui} />
          <Route path="/cerita" element={<p>daftar proyek</p>} />
          <Route path="/publish" element={<p>halaman publish</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>
  );
}

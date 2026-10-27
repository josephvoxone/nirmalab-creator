import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, NO_MODEL_MESSAGE, type ActionContext } from '../src/assistant/actions.js';
import { BreakdownError, REPLACE_REFUSED_MESSAGE, breakdownScene, parseIntents } from '../src/assistant/breakdown.js';
import { buildApp } from '../src/app.js';
import type { ChatInput, ChatOutput, TextModel } from '../src/llm/opencode.js';
import { STALE_MESSAGE } from '../src/stories/service.js';
import { compileBoardShot, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { bibleBoard, renderedStory, serviceSetup } from './bible-board.js';

/** Scripted text model: each call returns the next reply and records what it was sent. */
function fakeModel(replies: string[]): TextModel & { calls: ChatInput[] } {
  const calls: ChatInput[] = [];
  return {
    calls,
    configured: async () => true,
    chat: async (input: ChatInput): Promise<ChatOutput> => {
      calls.push(JSON.parse(JSON.stringify({ ...input, signal: undefined })));
      const content = replies[Math.min(calls.length - 1, replies.length - 1)] ?? '[]';
      return { message: { role: 'assistant', content }, model: 'glm-5.3' };
    }
  };
}

const intent = (i: number, extra: Record<string, unknown> = {}) => ({
  subject: 'LARAS',
  action: ['carries the basket toward the market gate', 'stops at the mouth of the narrow alley', 'sets the basket down on a dry crate'][i % 3],
  startState: ['she stands between the fish stalls', 'she walks past the gate', 'the basket is in her arms'][i % 3],
  endState: ['she reaches the market gate', 'she stands in the alley shade', 'the basket rests on the crate'][i % 3],
  emotion: 'tegang',
  framing: ['wide', 'medium', 'close-up'][i % 3],
  move: ['tracking', 'static', 'push-in'][i % 3],
  narration: ['Laras membawa keranjang ke gerbang.', 'Laras berhenti di mulut gang.', 'Keranjang diletakkan di atas peti.'][i % 3],
  ...extra
});

/** Bible board with a second scene that only holds an empty placeholder shot (as "Tambah shot" makes it). */
const withPlaceholder = (): Storyboard => {
  const b = bibleBoard();
  return {
    ...b,
    scenes: [...b.scenes!, { id: 'gang', title: 'Di Gang', location: 'PASAR_IKAN', shots: ['shot-3'] }],
    bible: { ...b.bible!, scenes: [...b.bible!.scenes, { id: 'gang', title: 'Di Gang', goal: 'Laras membawa Kapas keluar pasar', location: 'PASAR_IKAN' }] },
    shots: [...b.shots, { id: 'shot-3', prompt: 'Medium shot, the camera stays still. ', narration: 'Tulis narasi singkat di sini.' }]
  };
};

const ctxFor = (t: ReturnType<typeof serviceSetup>, model?: TextModel): ActionContext => ({
  stories: t.service, snapshots: t.service.snapshots, model, userId: 'u_admin', source: 'chat', turn: {}
});

describe('parseIntents', () => {
  it('reads a bare array, a ```json fence and a {shots:[…]} wrapper', () => {
    expect(parseIntents('[{"subject":"A"}]')).toEqual([{ subject: 'A' }]);
    expect(parseIntents('Here you go:\n```json\n[{"subject":"A"},{"subject":"B"}]\n```')).toHaveLength(2);
    expect(parseIntents('{"shots":[{"subject":"A"}]}')).toEqual([{ subject: 'A' }]);
    expect(parseIntents('no json here')).toBeUndefined();
  });
});

describe('breakdownScene', () => {
  it('returns compiled, lint-clean shots for the scene, grounded in the bible prompt', async () => {
    const model = fakeModel([JSON.stringify([intent(0), intent(1), intent(2)])]);
    const board = withPlaceholder();
    const shots = await breakdownScene(model, board, 'gang', 3, 'Laras harus cepat');
    expect(shots).toHaveLength(3);
    expect(new Set(shots.map(s => s.id)).size).toBe(3);
    for (const s of shots) expect(board.shots.some(b => b.id === s.id)).toBe(false);
    expect(model.calls).toHaveLength(1);
    const sent = model.calls[0]!.messages.map(m => m.content).join('\n');
    for (const fact of ['Laras membawa Kapas keluar pasar', 'two black braids', 'LARAS', 'a busy fish market at dawn', 'Seorang gadis penjual ikan', '12', 'Laras harus cepat', 'exactly 3']) expect(sent).toContain(fact);
    expect(sent).toMatch(/Kapas menunggu di keranjang|lifts the woven basket/); // neighbouring shot for continuity
    const preview = { ...board, scenes: board.scenes!.map(sc => (sc.id === 'gang' ? { ...sc, shots: shots.map(s => s.id) } : sc)), shots: [...board.shots.slice(0, 2), ...shots] };
    for (const s of shots) {
      expect(s.intent!.subject).toBe('LARAS');
      expect(s.prompt).toMatch(/LARAS/);
      expect(() => compileBoardShot(preview, s)).not.toThrow();
    }
  });

  it('feeds compile/lint issues back once and accepts the fixed reply', async () => {
    const bad = [intent(0, { action: 'grabs the basket and then runs away' }), intent(1), intent(2)];
    const model = fakeModel([`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``, JSON.stringify([intent(0), intent(1), intent(2)])]);
    const shots = await breakdownScene(model, withPlaceholder(), 'gang', 3);
    expect(shots).toHaveLength(3);
    expect(model.calls).toHaveLength(2);
    const feedback = model.calls[1]!.messages.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toMatch(/shot 1/);
    expect(feedback.content).toMatch(/and then/);
  });

  it('still failing after one retry → BreakdownError with the issues', async () => {
    const model = fakeModel([JSON.stringify([intent(0, { startState: 'x', endState: 'x' }), intent(1)])]);
    const error = await breakdownScene(model, withPlaceholder(), 'gang', 2).catch(e => e);
    expect(error).toBeInstanceOf(BreakdownError);
    expect(model.calls).toHaveLength(2);
    expect((error as Error).message).toMatch(/state change/);
  });

  it('a wrong number of shots or an unknown camera id is an issue', async () => {
    const model = fakeModel([JSON.stringify([intent(0)]), JSON.stringify([intent(0, { move: 'drone-orbit' }), intent(1)])]);
    const error = await breakdownScene(model, withPlaceholder(), 'gang', 2).catch(e => e);
    expect(error).toBeInstanceOf(BreakdownError);
    expect(model.calls[1]!.messages.at(-1)!.content).toMatch(/2 shots/);
    expect((error as Error).message).toMatch(/drone-orbit/);
  });

  it('camera ids: rack-focus is accepted, loose spelling is normalised, an unknown move is fed back with the valid ids', async () => {
    const model = fakeModel([
      JSON.stringify([intent(0, { move: 'snap-focus' }), intent(1, { move: 'Rack Focus' }), intent(2)]),
      JSON.stringify([intent(0, { move: 'rack-focus' }), intent(1, { move: 'Rack Focus' }), intent(2)])
    ]);
    const shots = await breakdownScene(model, withPlaceholder(), 'gang', 3);
    expect(model.calls).toHaveLength(2);
    const feedback = model.calls[1]!.messages.at(-1)!.content;
    expect(feedback).toMatch(/shot 1: move "snap-focus" is not one of/);
    expect(feedback).toContain('rack-focus');
    expect(feedback).not.toMatch(/shot 2/);
    expect(shots.map(s => s.intent!.move)).toEqual(['rack-focus', 'rack-focus', 'push-in']);
  });

  it('narration over the word limit or with empty adjectives is an issue', async () => {
    const long = 'Laras berjalan pelan melewati lapak ikan yang basah sambil memeluk keranjang erat sekali.';
    const model = fakeModel([JSON.stringify([intent(0, { narration: long }), intent(1, { narration: 'Pasar yang indah.' })])]);
    const error = await breakdownScene(model, withPlaceholder(), 'gang', 2).catch(e => e);
    expect(error).toBeInstanceOf(BreakdownError);
    expect(model.calls[1]!.messages.at(-1)!.content).toMatch(/narasi|narration/);
    expect(model.calls[1]!.messages.at(-1)!.content).toMatch(/indah/);
  });
});

describe('breakdown_scene action', () => {
  it('replaces a scene of empty placeholders with 3 compiled shots (one snapshot, rev +1)', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const model = fakeModel([JSON.stringify([intent(0), intent(1), intent(2)])]);
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 2, count: 3 });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect((r as { label: string }).label).toMatch(/Scene 2/);
    const board = await t.service.readStoryboard(story.id);
    const gang = board.scenes!.find(s => s.id === 'gang')!;
    expect(gang.shots).toHaveLength(3);
    expect(gang.shots).not.toContain('shot-3');
    expect(board.scenes![0]!.shots).toEqual(['01-laras', '02-kapas']);
    expect(validateStoryboard(board)).toEqual([]);
    for (const id of gang.shots) expect(() => compileBoardShot(board, board.shots.find(s => s.id === id)!)).not.toThrow();
    expect((await t.service.get(story.id))!.rev).toBe(2);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(1);
  });

  it('no text model → code NOT_CONFIGURED (not UNAVAILABLE) with the one shared message', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t), story.id, { scene: 2, count: 2 });
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED', error: NO_MODEL_MESSAGE });
  });

  it('appends to a scene that already has real shots', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const model = fakeModel([JSON.stringify([intent(0), intent(1)])]);
    expect(await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 1, count: 2 })).toMatchObject({ ok: true });
    const board = await t.service.readStoryboard(story.id);
    expect(board.scenes![0]!.shots.slice(0, 2)).toEqual(['01-laras', '02-kapas']);
    expect(board.scenes![0]!.shots).toHaveLength(4);
  });

  it('replace is refused over a scene with a done clip or keyframe (paid takes are never dropped)', async () => {
    const t = serviceSetup();
    const story = await renderedStory(t, withPlaceholder());
    expect(story.shots.find(s => s.id === '01-laras')!.status).toBe('done');
    const before = readFileSync(join(t.dataDir, 'stories', story.id, 'storyboard.json'), 'utf8');
    const model = fakeModel([JSON.stringify([intent(0), intent(1)])]);
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 1, count: 2, mode: 'replace' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe(REPLACE_REFUSED_MESSAGE);
    expect(model.calls).toHaveLength(0);
    expect(readFileSync(join(t.dataDir, 'stories', story.id, 'storyboard.json'), 'utf8')).toBe(before);
  });

  it('a character that is only in startState/endState is sent back once: every visible character must be in subject or action', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const hidden = { ...intent(0), startState: 'KAPAS sleeps in the basket' };
    const model = fakeModel([JSON.stringify([hidden, intent(1)]), JSON.stringify([{ ...hidden, action: 'carries the basket with KAPAS toward the market gate' }, intent(1)])]);
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 2, count: 2 });
    expect(r).toMatchObject({ ok: true });
    expect(model.calls).toHaveLength(2);
    expect(JSON.stringify(model.calls[1]!.messages)).toMatch(/KAPAS .*subject or action/);
  });

  it('an invalid intent gets one retry, then a plain error with nothing inserted', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const before = readFileSync(join(t.dataDir, 'stories', story.id, 'storyboard.json'), 'utf8');
    const model = fakeModel([JSON.stringify([intent(0, { action: '' }), intent(1), intent(2)])]);
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 2, count: 3 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/action/);
    expect(model.calls).toHaveLength(2);
    expect(readFileSync(join(t.dataDir, 'stories', story.id, 'storyboard.json'), 'utf8')).toBe(before);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(0);
  });

  it('a concurrent edit during the model call → STALE, nothing inserted, no snapshot', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withPlaceholder());
    const model = fakeModel([JSON.stringify([intent(0), intent(1), intent(2)])]);
    const chat = model.chat;
    model.chat = async input => {
      const board = await t.service.readStoryboard(story.id);
      await t.service.updateStoryboard(story.id, { ...board, title: 'Pasar Siang' });
      return chat(input);
    };
    const r = await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 2, count: 3 });
    expect(r).toMatchObject({ ok: false, error: STALE_MESSAGE, code: 'STALE' });
    const board = await t.service.readStoryboard(story.id);
    expect(board.title).toBe('Pasar Siang');
    expect(board.scenes!.find(s => s.id === 'gang')!.shots).toEqual(['shot-3']);
    expect(board.shots).toHaveLength(3);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(0);
  });

  it('legacy boards, missing model and a bad count are plain errors', async () => {
    const t = serviceSetup();
    const legacy = await t.service.create({ title: 'Kucing', shots: [{ id: 'a', prompt: 'Medium shot of a kitten.', narration: 'Mimi menunggu.' }] });
    const model = fakeModel(['[]']);
    expect(await ACTIONS.breakdown_scene.run(ctxFor(t, model), legacy.id, { scene: 1, count: 3 })).toEqual({ ok: false, error: 'Pecah scene butuh bible — buat bible dulu di tab Bible.', code: 'INVALID' });
    const story = await t.service.create(withPlaceholder());
    expect((await ACTIONS.breakdown_scene.run(ctxFor(t), story.id, { scene: 2, count: 3 }) as { error: string }).error).toMatch(/Model teks/);
    expect((await ACTIONS.breakdown_scene.run(ctxFor(t, model), story.id, { scene: 2, count: 9 }) as { error: string }).error).toMatch(/2–8/);
    expect(model.calls).toHaveLength(0);
  });
});

describe('breakdown route', () => {
  it('POST /api/stories/:id/scenes/:sceneId/breakdown inserts the shots (admin only)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-bd-'));
    const model = fakeModel([JSON.stringify([intent(0), intent(1)])]);
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 },
      text: { model }
    });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: withPlaceholder() } })).json().story.id;
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/scenes/gang/breakdown`, payload: { count: 2 } })).statusCode).toBe(401);
    const res = await server.inject({ method: 'POST', url: `/api/stories/${id}/scenes/gang/breakdown`, headers: { cookie }, payload: { count: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().undoId).toMatch(/^u_/);
    expect(res.json().storyboard.scenes[1].shots).toHaveLength(2);
    expect(res.json().story.rev).toBe(2);
    const bad = await server.inject({ method: 'POST', url: `/api/stories/${id}/scenes/nope/breakdown`, headers: { cookie }, payload: { count: 2 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/Scene/);
  });

  it('the route resolves the scene by id first, then by number', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-bd-'));
    const model = fakeModel([JSON.stringify([intent(0), intent(1)])]);
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 },
      text: { model }
    });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    // Scene 2 has the id "1": "/scenes/1/" means that scene, not scene number 1.
    const b = withPlaceholder();
    const board = {
      ...b,
      scenes: b.scenes!.map(s => (s.id === 'gang' ? { ...s, id: '1' } : s)),
      bible: { ...b.bible!, scenes: b.bible!.scenes.map(s => (s.id === 'gang' ? { ...s, id: '1' } : s)) }
    };
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story.id;
    const res = await server.inject({ method: 'POST', url: `/api/stories/${id}/scenes/1/breakdown`, headers: { cookie }, payload: { count: 2 } });
    expect(res.statusCode).toBe(200);
    const scenes = res.json().storyboard.scenes as Array<{ id: string; shots: string[] }>;
    expect(scenes.find(s => s.id === 'pasar')!.shots).toEqual(['01-laras', '02-kapas']);
    expect(scenes.find(s => s.id === '1')!.shots).toHaveLength(2);
    expect(scenes.find(s => s.id === '1')!.shots).not.toContain('shot-3');
    // A number still works when no scene has that id.
    const byNumber = await server.inject({ method: 'POST', url: `/api/stories/${id}/scenes/2/breakdown`, headers: { cookie }, payload: { count: 2 } });
    expect(byNumber.statusCode).toBe(200);
    const after = byNumber.json().storyboard.scenes as Array<{ id: string; shots: string[] }>;
    expect(after.find(s => s.id === 'pasar')!.shots).toEqual(['01-laras', '02-kapas']);
    expect(after.find(s => s.id === '1')!.shots).toHaveLength(4);
  });
});

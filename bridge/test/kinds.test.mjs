import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processJob, projectTitleFor, resultHeaders } from '../src/core.mjs';

const ok = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

/** Minimal fake of the google-flow MCP: one project, characters, media. */
function fakeFlow({ imageCost = 0, videoCost = 10, streamLost = false } = {}) {
  const state = { projects: [], characters: [], media: [], calls: [], completed: [], failed: [] };
  const callTool = async (_acc, name, args) => {
    state.calls.push([name, args]);
    switch (name) {
      case 'flow_list_projects': return ok(state.projects);
      case 'flow_create_project': { const p = { id: 'proj-' + state.projects.length, title: args.title }; state.projects.push(p); return ok(p); }
      case 'flow_get_project': return ok({ characters: state.characters, media: state.media.map(({ created, ...m }) => m), generations: [...state.media.map(m => ({ mediaId: m.mediaId, caption: m.caption, ...(m.created ? { created: m.created } : {}) })), ...(state.gens ?? [])] });
      case 'flow_create_character': {
        const c = { id: 'ch-' + args.name, name: args.name, portraitMediaId: 'portrait-' + args.name };
        state.characters.push(c); state.media.push({ mediaId: c.portraitMediaId, kind: 'image', caption: 'sheet ' + args.name });
        return ok({ character: c });
      }
      case 'flow_agent_chat': {
        const isVideo = /video/i.test(args.message) && !/no video/i.test(args.message);
        const cost = isVideo ? videoCost : imageCost;
        if (cost > args.max_credits) return ok({ approval: 'awaiting', pendingPermission: { totalCost: cost }, generatedMediaIds: [] });
        const m = { mediaId: (isVideo ? 'vid-' : 'img-') + state.media.length, kind: isVideo ? 'video' : 'image', caption: isVideo ? '' : 'Girl on porch ' + state.media.length };
        state.media.push(m);
        return ok({ approval: cost ? 'approved' : 'none', generatedMediaIds: streamLost ? [] : [m.mediaId], reply: 'ok' });
      }
      case 'flow_agent_respond': return ok({});
      case 'flow_video_status': return ok({ items: args.media_ids.map(id => ({ mediaId: id, state: 'succeeded' })) });
      case 'flow_download_media': return ok({ path: '/tmp/' + args.media_id });
      default: throw new Error('unexpected tool ' + name);
    }
  };
  const deps = {
    callTool, mode: 'agent', maxCredits: 20, outDir: '/tmp', resolution: '720p',
    readFile: async p => Buffer.from('bytes:' + p),
    complete: async (id, bytes, meta) => state.completed.push({ id, bytes: String(bytes), meta }),
    fail: async (id, error) => state.failed.push({ id, error }),
    resolveProject: async () => { throw new Error('group jobs must not use the shared project'); },
    pollMs: 1, pollTries: 3
  };
  return { state, deps };
}

const account = { id: 'acc_1', label: 'Flow 01', profileDir: 'cdp:http://127.0.0.1:9333' };

test('projectTitleFor: story jobs get their own Flow project', () => {
  assert.equal(projectTitleFor({ group: 'story_0123456789abcdef' }, 'OpenCreator jobs'), 'Nirmalab · story_0123456789abcdef');
  assert.equal(projectTitleFor({}, 'OpenCreator jobs'), 'OpenCreator jobs');
});

test('character job: creates the Flow character from the sheet prompt and uploads the sheet with its ids', async () => {
  const { state, deps } = fakeFlow();
  const job = { id: 'job_c', kind: 'character', group: 'story_1', prompt: 'Full body reference sheet of Laras', characters: [{ name: 'Laras', look: 'girl' }] };
  const r = await processJob({ job, account }, deps);
  assert.equal(r.status, 'done');
  const create = state.calls.find(c => c[0] === 'flow_create_character');
  assert.deepEqual(create[1], { project_id: 'proj-0', name: 'Laras', portrait_prompt: 'Full body reference sheet of Laras' });
  assert.deepEqual(state.completed[0].meta, { mediaId: 'portrait-Laras', flowCharacterId: 'ch-Laras' });
  assert.equal(state.projects[0].title, 'Nirmalab · story_1');
});

test('character job is idempotent: an existing character of that name is reused, nothing regenerated', async () => {
  const { state, deps } = fakeFlow();
  state.projects.push({ id: 'proj-x', title: 'Nirmalab · story_1' });
  state.characters.push({ id: 'ch-old', name: 'Laras', portraitMediaId: 'p-old' });
  await processJob({ job: { id: 'j', kind: 'character', group: 'story_1', prompt: 'sheet', characters: [{ name: 'Laras', look: 'g' }] }, account }, deps);
  assert.equal(state.calls.some(c => c[0] === 'flow_create_character'), false);
  assert.deepEqual(state.completed[0].meta, { mediaId: 'p-old', flowCharacterId: 'ch-old' });
});

test('image job: characters attached, free only (max_credits 0), uploads the still with media id + caption', async () => {
  const { state, deps } = fakeFlow();
  state.projects.push({ id: 'proj-x', title: 'Nirmalab · story_1' });
  state.characters.push({ id: 'ch-Laras', name: 'Laras', portraitMediaId: 'p' });
  const job = { id: 'job_i', kind: 'image', group: 'story_1', aspect: '9:16', prompt: 'Laras on a porch at dusk.', characters: [{ name: 'Laras', look: 'girl' }, { name: 'Kapas', look: 'rabbit' }] };
  const r = await processJob({ job, account }, deps);
  assert.equal(r.status, 'done');
  const chat = state.calls.find(c => c[0] === 'flow_agent_chat')[1];
  assert.deepEqual(chat.character_ids.sort(), ['ch-Kapas', 'ch-Laras']);
  assert.equal(chat.max_credits, 0);
  assert.match(chat.message, /exactly one image/i);
  assert.match(chat.message, /Laras on a porch at dusk\./);
  assert.ok(state.calls.some(c => c[0] === 'flow_create_character' && c[1].name === 'Kapas'), 'missing character recreated from its look');
  assert.match(state.completed[0].meta.caption, /Girl on porch/);
  assert.match(state.completed[0].meta.mediaId, /^img-/);
});

test('image job that Flow wants to charge for is rejected and failed, nothing spent', async () => {
  const { state, deps } = fakeFlow({ imageCost: 2 });
  await processJob({ job: { id: 'j', kind: 'image', group: 'g', prompt: 'x', characters: [] }, account }, deps);
  assert.ok(state.calls.some(c => c[0] === 'flow_agent_respond' && c[1].answer === 'Reject'));
  assert.match(state.failed[0].error, /credits/);
});

test('video job with startFrame attaches the keyframe image and asks to animate it', async () => {
  const { state, deps } = fakeFlow();
  state.projects.push({ id: 'proj-x', title: 'Nirmalab · story_1' });
  state.characters.push({ id: 'ch-Laras', name: 'Laras', portraitMediaId: 'p' });
  state.media.push({ mediaId: 'frame-1', kind: 'image', caption: 'Girl on porch' });
  const job = { id: 'job_v', kind: 'video', group: 'story_1', aspect: '9:16', durationSec: 6, prompt: 'Medium shot, the camera pushes in slowly. Laras smiles.', startFrame: { mediaId: 'frame-1', caption: 'Girl on porch' }, characters: [{ name: 'Laras', look: 'girl' }] };
  const r = await processJob({ job, account }, deps);
  assert.equal(r.status, 'done');
  const chat = state.calls.find(c => c[0] === 'flow_agent_chat')[1];
  assert.deepEqual(chat.image_ids, ['frame-1']);
  assert.deepEqual(chat.character_ids, ['ch-Laras']);
  assert.match(chat.message, /first frame/i);
  assert.match(chat.message, /native audio/i);
  assert.equal(chat.max_credits, 20);
});

test('when the agent stream is lost, the new media is found by diffing the project', async () => {
  const { state, deps } = fakeFlow({ streamLost: true });
  state.projects.push({ id: 'proj-x', title: 'Nirmalab · g' });
  const r = await processJob({ job: { id: 'j', kind: 'image', group: 'g', prompt: 'valley', characters: [] }, account }, deps);
  assert.equal(r.status, 'done');
  assert.match(state.completed[0].meta.mediaId, /^img-/);
});

test('resultHeaders encodes ids and free-text caption', () => {
  assert.deepEqual(resultHeaders({ mediaId: 'm1', caption: 'Girl, café & rain', flowCharacterId: 'c1' }),
    { 'x-flow-media-id': 'm1', 'x-flow-caption': 'Girl%2C%20caf%C3%A9%20%26%20rain', 'x-flow-character-id': 'c1' });
  assert.deepEqual(resultHeaders(), {});
});

test('stream lost: a late image from an older, interrupted turn is not mistaken for this job', async () => {
  const { state, deps } = fakeFlow({ streamLost: true });
  state.projects.push({ id: 'proj-x', title: 'Nirmalab · g' });
  const realChat = deps.callTool;
  let injected = false;
  deps.callTool = async (acc, name, args) => {
    if (name === 'flow_agent_chat' && !injected) {
      injected = true; // the old turn's image lands just now, created 3 minutes ago
      state.media.push({ mediaId: 'stale-1', kind: 'image', caption: 'princess' });
      state.gens = [{ mediaId: 'stale-1', created: new Date(Date.now() - 180_000).toISOString() }];
    }
    const r = await realChat(acc, name, args);
    if (name === 'flow_agent_chat') state.media.at(-1).created = new Date().toISOString();
    return r;
  };
  const r = await processJob({ job: { id: 'j', kind: 'image', group: 'g', prompt: 'valley', characters: [] }, account }, deps);
  assert.equal(r.status, 'done');
  assert.notEqual(state.completed[0].meta.mediaId, 'stale-1');
});

// E2E against a running Nirmalab Creator container (real image: ffmpeg + python assembler).
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, BRIDGE_TOKEN, CLIP_A, CLIP_B, CLIP_SILENT, OUT, SHEET, FRAME_PORTRAIT, FRAME_LANDSCAPE
import { readFileSync, writeFileSync } from 'node:fs';

const { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, BRIDGE_TOKEN, CLIP_A, CLIP_B, CLIP_SILENT, OUT, SHEET, FRAME_PORTRAIT, FRAME_LANDSCAPE } = process.env;
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const health = await (await fetch(`${BASE}/api/health`)).json();
check('health', health.ok === true, `version ${health.version}`);
const page = await fetch(`${BASE}/cerita`);
check('SPA clean URL /cerita serves index.html', page.status === 200 && (await page.text()).includes('id="root"'));
check('anonymous API is 401', (await fetch(`${BASE}/api/stories`)).status === 401);
check('bridge with wrong token is 401', (await fetch(`${BASE}/api/flow/bridge/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flow-bridge-token': 'nope' }, body: '{}' })).status === 401);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
check('admin login', login.status === 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const bridge = (path, body, type = 'application/json') => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': type, 'x-flow-bridge-token': BRIDGE_TOKEN }, body: type === 'application/json' ? JSON.stringify(body ?? {}) : body
});

check('add Flow account', (await api('/api/flow/accounts', { method: 'POST', body: JSON.stringify({ label: 'e2e', email: 'e2e@example.local', profileDir: 'cdp:http://127.0.0.1:9333' }) })).status === 200);

const board = {
  title: 'E2E Selendang',
  titleCard: { lines: ['E2E', 'SELENDANG'], kicker: 'Uji' },
  crossfade: 0.3,
  characters: { RABBIT: 'a small cream-colored rabbit with a red knitted scarf' },
  audio: 'Audio: voice-over speaking Bahasa Indonesia: "{line}"',
  shots: [
    { id: '01-hadiah', prompt: 'Medium close-up, the camera pushes in slowly. RABBIT on a porch.', narration: 'Namanya Kapas, kelinci kesayangan Laras.' },
    { id: '02-dibuang', prompt: 'Wide shot, the camera stays still. A box on a rainy road.', narration: 'Suatu malam, Kapas dibuang ke pinggir jalan.' }
  ]
};
const invalid = await api('/api/stories', { method: 'POST', body: JSON.stringify({ storyboard: { ...board, shots: [{ id: 'x', prompt: 'A jib arm rises.', narration: 'Halo.' }] } }) });
check('invalid storyboard rejected with rule', invalid.status === 400 && /gear/.test(invalid.body.error?.message), invalid.body.error?.message);
const created = await api('/api/stories', { method: 'POST', body: JSON.stringify({ storyboard: board }) });
check('create story', created.status === 201);
const id = created.body.story.id;
const rendered = await api(`/api/stories/${id}/render`, { method: 'POST', body: '{}' });
check('render queues shots', rendered.status === 200 && rendered.body.story.status === 'rendering');

async function takeOne(file) {
  const claim = await bridge('/api/flow/bridge/claim', { bridgeId: 'e2e-mac' });
  if (claim.status !== 200) return undefined;
  const { job } = await claim.json();
  const up = await bridge(`/api/flow/bridge/jobs/${job.id}/complete`, readFileSync(file(job)), 'application/octet-stream');
  check(`bridge upload ${job.technique}`, up.status === 200, file(job).split('/').pop());
  return job;
}
// first take of 02 has no audio → must be rejected by QC and re-queued
await takeOne(job => (job.technique.endsWith('01-hadiah') ? CLIP_A : CLIP_SILENT));
await takeOne(job => (job.technique.endsWith('01-hadiah') ? CLIP_A : CLIP_SILENT));
let story = (await api(`/api/stories/${id}`)).body.story;
const s2 = story.shots.find(s => s.id === '02-dibuang');
check('QC rejected the silent take and re-queued', s2.status === 'queued' && s2.attempts === 1 && /no audio/.test(s2.lastError ?? ''), JSON.stringify(s2));
check('good take accepted', story.shots.find(s => s.id === '01-hadiah').status === 'done');
await takeOne(() => CLIP_B);

const t0 = Date.now();
for (;;) {
  story = (await api(`/api/stories/${id}`)).body.story;
  if (story.status === 'done' || story.status === 'failed' || Date.now() - t0 > 300_000) break;
  await sleep(2000);
}
check('story assembled in the container', story.status === 'done', `${story.status} after ${Math.round((Date.now() - t0) / 1000)} s ${story.error ?? ''}`);
const video = await fetch(`${BASE}/api/stories/${id}/video`, { headers: { cookie } });
const bytes = Buffer.from(await video.arrayBuffer());
check('final video downloads', video.status === 200 && video.headers.get('content-type') === 'video/mp4' && bytes.length > 100_000, `${bytes.length} B`);
writeFileSync(OUT, bytes);
const range = await fetch(`${BASE}/api/stories/${id}/video`, { headers: { cookie, range: 'bytes=0-1023' } });
check('range request (video seeking)', range.status === 206 && (await range.arrayBuffer()).byteLength === 1024);
check('video needs a session', (await fetch(`${BASE}/api/stories/${id}/video`)).status === 401);
const jobs = (await api('/api/flow/jobs')).body.jobs;
check('exactly 3 Flow jobs (2 shots + 1 re-take)', jobs.length === 3, `${jobs.length}`);

// ---------------- konsisten: character sheet → keyframes (QC) → animate keyframes → assemble
const catalog = await api('/api/stories/catalog');
check('catalog served', catalog.status === 200 && catalog.body.catalog.templates.length >= 10 && catalog.body.catalog.moves.length >= 20);
const kboard = { ...board, title: 'E2E Konsisten', mode: 'konsisten', characters: { KAPAS: { name: 'Kapas', look: 'a small cream-colored rabbit with a red knitted scarf' } },
  shots: [{ ...board.shots[0], prompt: 'Medium close-up, the camera pushes in slowly. KAPAS on a porch.' }, { ...board.shots[1], prompt: 'Wide shot, the camera stays still. KAPAS waits on a rainy road.' }] };
const kid = (await api('/api/stories', { method: 'POST', body: JSON.stringify({ storyboard: kboard }) })).body.story.id;
check('render refused before keyframes', (await api(`/api/stories/${kid}/render`, { method: 'POST', body: '{}' })).status === 400);
check('prepare → casting', (await api(`/api/stories/${kid}/prepare`, { method: 'POST', body: '{}' })).body.story.status === 'casting');
async function takeK(kind, file, meta) {
  const claim = await bridge('/api/flow/bridge/claim', { bridgeId: 'e2e-mac' });
  const { job } = await claim.json();
  check(`claim ${kind}`, job?.kind === kind, `${job?.kind} ${job?.technique}`);
  const headers = { 'content-type': 'application/octet-stream', 'x-flow-bridge-token': BRIDGE_TOKEN, 'x-flow-media-id': `m-${job.id}`, 'x-flow-caption': encodeURIComponent('Kapas · frame'), ...(meta ?? {}) };
  const up = await fetch(`${BASE}/api/flow/bridge/jobs/${job.id}/complete`, { method: 'POST', headers, body: readFileSync(file) });
  check(`upload ${kind}`, up.status === 200);
  return job;
}
const sheetJob = await takeK('character', SHEET, { 'x-flow-character-id': 'fc-kapas' });
check('character job carries the look', sheetJob.characters?.[0]?.name === 'Kapas' && /red knitted scarf/.test(sheetJob.characters[0].look));
let k = (await api(`/api/stories/${kid}`)).body;
check('sheet accepted → framing', k.story.status === 'framing' && k.story.cast[0].status === 'done', k.story.status);
const sheetImg = await fetch(`${BASE}/api/stories/${kid}/cast/KAPAS/image`, { headers: { cookie } });
check('sheet served with real type', sheetImg.status === 200 && /^image\//.test(sheetImg.headers.get('content-type')), sheetImg.headers.get('content-type'));
const f1 = await takeK('image', FRAME_LANDSCAPE);
check('keyframe job attaches the character, same group', f1.characters?.[0]?.name === 'Kapas' && f1.group === kid);
await takeK('image', FRAME_PORTRAIT);
k = (await api(`/api/stories/${kid}`)).body;
const rejected = k.story.shots.find(s => s.frame?.status === 'queued');
check('landscape keyframe rejected by QC and redrawn', !!rejected && /9:16|portrait/i.test(rejected.frame.lastError ?? ''), JSON.stringify(rejected?.frame));
await takeK('image', FRAME_PORTRAIT);
k = (await api(`/api/stories/${kid}`)).body;
check('all keyframes → review', k.story.status === 'review', k.story.status);
const frameImg = await fetch(`${BASE}/api/stories/${kid}/shots/01-hadiah/frame`, { headers: { cookie } });
check('keyframe image served', frameImg.status === 200 && (await frameImg.arrayBuffer()).byteLength > 10_000);
check('render from review', (await api(`/api/stories/${kid}/render`, { method: 'POST', body: '{}' })).body.story.status === 'rendering');
for (const clip of [CLIP_A, CLIP_B]) {
  const job = await takeK('video', clip);
  check('video job animates its keyframe', !!job.startFrame?.mediaId && job.characters?.[0]?.name === 'Kapas', JSON.stringify(job.startFrame));
}
const t1 = Date.now();
for (;;) {
  k = (await api(`/api/stories/${kid}`)).body;
  if (k.story.status === 'done' || k.story.status === 'failed' || Date.now() - t1 > 300_000) break;
  await sleep(2000);
}
check('konsisten story assembled', k.story.status === 'done', `${k.story.status} ${k.story.error ?? ''}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

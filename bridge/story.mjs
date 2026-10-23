#!/usr/bin/env node
/**
 * Generate every shot of a storyboard in Google Flow, resumably.
 *   node story.mjs <slug | path/to/storyboard.json> [--limit N] [--cdp http://127.0.0.1:9333]
 * Files: $FLOW_HOME/stories/<slug>/ (default ~/Documents/nirmalab/flow) — storyboard.json, <shot-id>.mp4, progress.json
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureProject, parseToolResult } from './src/core.mjs';
import { CREDITS_PER_SHOT, buildShotPrompt, pendingShots, validateStory } from './src/story.mjs';
import { storyDir, storyFile } from './src/paths.mjs';

const args = process.argv.slice(2);
const storyPath = storyFile(args[0]);
const cdp = args.includes('--cdp') ? args[args.indexOf('--cdp') + 1] : 'http://127.0.0.1:9333';
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const story = JSON.parse(await readFile(storyPath, 'utf8'));
const outDir = storyDir(story.slug);
await mkdir(outDir, { recursive: true });
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

const sdk = join(homedir(), 'tools/google-flow-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client');
const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);
const env = { ...process.env, FLOW_CDP_URL: cdp, FLOW_OUTPUT_DIR: join(outDir, '.raw') };
delete env.FLOW_BRIDGE_TOKEN;
const client = new Client({ name: 'story', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(homedir(), 'tools/google-flow-mcp/dist/index.js')], env, stderr: 'ignore' }));
const callRaw = (name, a) => client.callTool({ name, arguments: a }, undefined, { timeout: 25 * 60_000 });
const call = async (name, a) => parseToolResult(await callRaw(name, a));

const progressFile = join(outDir, 'progress.json');
const progress = existsSync(progressFile) ? JSON.parse(await readFile(progressFile, 'utf8')) : {};
const save = () => writeFile(progressFile, JSON.stringify(progress, null, 1));
const isDone = id => existsSync(join(outDir, `${id}.mp4`));

try {
  const credits = (await call('flow_status', {})).credits;
  const errors = validateStory(story, { budget: credits, isDone });
  const todo = pendingShots(story, isDone).slice(0, limit);
  log(`story "${story.title}": ${todo.length} shots to generate, credits ${credits}`);
  if (errors.length) log('validation:', errors.join(' | '));
  if (errors.some(e => !/^budget/.test(e))) throw new Error('storyboard invalid');

  const projectId = await ensureProject({ id: 'story' }, (_a, n, x) => callRaw(n, x), `Story · ${story.title}`);
  log('project', projectId);

  for (const shot of todo) {
    const left = (await call('flow_status', {})).credits;
    if (left < CREDITS_PER_SHOT) { log(`stop: ${left} credits left, need ${CREDITS_PER_SHOT}`); break; }
    const prompt = buildShotPrompt(story, shot);
    const before = new Set(((await call('flow_get_project', { project_id: projectId })).media ?? []).map(m => m.mediaId));
    log(`${shot.id}: asking Flow (credits ${left})`);
    const chat = await call('flow_agent_chat', {
      project_id: projectId,
      new_session: true,
      max_credits: story.maxCreditsPerShot ?? 12,
      message: `Generate exactly one video (no images, no extra shots, no variations) in ${story.aspect ?? '9:16'} aspect ratio, 6 seconds, with the Omni 1.1 Flash model and its native audio. Use this prompt verbatim, do not rewrite it:\n\n${prompt}`
    });
    if (chat.approval === 'awaiting') {
      await callRaw('flow_agent_respond', { project_id: projectId, answer: 'Reject' }).catch(() => {});
      log(`${shot.id}: quote ${chat.pendingPermission?.totalCost} above cap, rejected`);
      progress[shot.id] = { status: 'rejected', quote: chat.pendingPermission?.totalCost };
      await save();
      continue;
    }
    let mediaId = chat.generatedMediaIds?.[0];
    for (let i = 0; !mediaId && i < 30; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const now = (await call('flow_get_project', { project_id: projectId })).media ?? [];
      mediaId = now.map(m => m.mediaId).find(id => !before.has(id));
    }
    if (!mediaId) { log(`${shot.id}: no media appeared; reply: ${String(chat.reply).slice(0, 160)}`); progress[shot.id] = { status: 'no-media' }; await save(); continue; }
    progress[shot.id] = { status: 'rendering', mediaId };
    await save();
    log(`${shot.id}: rendering ${mediaId}`);
    const st = await call('flow_video_status', { media_ids: [mediaId], wait: true, timeout_sec: 1500 });
    const state = st.items?.[0]?.state;
    if (state !== 'succeeded') { log(`${shot.id}: ${state}${st.timedOut ? ' (timed out)' : ''}`); progress[shot.id] = { status: state ?? 'unknown', mediaId }; await save(); continue; }
    const dl = await call('flow_download_media', { media_id: mediaId });
    await copyFile(dl.path, join(outDir, `${shot.id}.mp4`));
    progress[shot.id] = { status: 'done', mediaId, creditsLeft: st.creditsLeft };
    await save();
    log(`${shot.id}: done (credits left ${st.creditsLeft})`);
  }
} finally {
  await client.close().catch(() => {});
}
const missing = story.shots.filter(s => !s.reuse && !isDone(s.id)).map(s => s.id);
log(missing.length ? `missing: ${missing.join(', ')}` : 'all shots ready');

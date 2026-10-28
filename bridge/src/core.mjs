/**
 * Flow bridge core — pure logic, all I/O injected so it is unit-testable.
 *
 * One job: generate a clip in Google Flow (via google-flow-mcp tools), download
 * the mp4, and upload it to OpenCreator. Failures are reported back with an
 * optional account cooldown so the server rotates to the next account.
 */

export function parseToolResult(result) {
  const text = (result?.content ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n');
  if (result?.isError) throw new Error(text || 'Flow tool failed');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const MIN = 60_000;

/** Map an error message to a cooldown for the account that produced it. */
export function classifyError(message) {
  const m = String(message ?? '').toLowerCase();
  if (/not enough credits|insufficient credits|out of credits|exceeds max_credits|quota/.test(m)) {
    return { kind: 'credits', cooldownMs: 6 * 60 * MIN };
  }
  if (/429|too many|rate.?limit|try again later|unusual traffic/.test(m)) {
    return { kind: 'rate-limit', cooldownMs: 30 * MIN };
  }
  if (/recaptcha|captcha|sign in|signed out|not signed/.test(m)) {
    return { kind: 'auth', cooldownMs: 60 * MIN };
  }
  // The Flow Chrome answers /json/version but refuses to be driven (stale after hours / an update):
  // not the job's or the account's fault — release the job and restart that Chrome.
  if (/connectovercdp|browser context management is not supported|setdownloadbehavior|econnrefused 127\.0\.0\.1:93\d\d/.test(m)) {
    return { kind: 'chrome', cooldownMs: 0 };
  }
  if (/timeout|timed out|net::|econnreset|socket hang up|target closed|browser has been closed/.test(m)) {
    return { kind: 'transient', cooldownMs: 5 * MIN };
  }
  return { kind: 'job', cooldownMs: 0 };
}

export async function ensureProject(account, callTool, title) {
  const projects = parseToolResult(await callTool(account, 'flow_list_projects', {}));
  const found = Array.isArray(projects) ? projects.find(p => p?.title === title) : undefined;
  if (found?.id) return found.id;
  const created = parseToolResult(await callTool(account, 'flow_create_project', { title }));
  if (!created?.id) throw new Error('Could not create Flow project');
  return created.id;
}

/**
 * @param {{ job: { id: string, prompt: string, aspect?: string, durationSec?: number }, account: { id: string } }} claim
 * @param {{ callTool: Function, readFile: Function, complete: Function, fail: Function,
 *           projectId?: string, resolveProject?: Function, maxCredits: number, outDir: string, resolution?: string }} deps
 */
/** Story jobs live in their own Flow project so characters and keyframes stay together. */
export function projectTitleFor(job, fallback) {
  return job?.group ? `Nirmalab · ${job.group}` : fallback;
}

export async function processJob(claim, rawDeps) {
  const { job, account } = claim;
  let chromeBroken = false;
  // A Chrome fault never burns an attempt: hand the job back (the bridge restarts Chrome and the
  // server re-queues a job its own bridge abandoned) when the bridge can release.
  const deps = !rawDeps.release ? rawDeps : {
    ...rawDeps,
    fail: async (id, reason, cooldownMs) => {
      if (classifyError(reason).kind === 'chrome') { chromeBroken = true; return rawDeps.release(id, reason); }
      return rawDeps.fail(id, reason, cooldownMs);
    }
  };
  const result = await runJob(job, account, deps);
  return chromeBroken ? { status: 'chrome-broken', error: result.error } : result;
}

async function runJob(job, account, deps) {
  try {
    if (job.kind === 'character' || job.kind === 'image' || (job.kind === 'video' && job.group)) {
      return await storyJob(job, account, deps);
    }
    const projectId = deps.resolveProject ? await deps.resolveProject(account) : deps.projectId;
    const duration = [4, 6, 8, 10].includes(job.durationSec) ? job.durationSec : 4;
    if (deps.mode === 'agent') return await agentJob(job, account, projectId, duration, deps);
    const generated = parseToolResult(await deps.callTool(account, 'flow_generate_video', {
      project_id: projectId,
      prompt: job.prompt,
      family: 'omni',
      duration_sec: duration,
      resolution: deps.resolution ?? '360p',
      aspect: job.aspect === '16:9' ? '16:9' : '9:16',
      count: 1,
      wait: true,
      max_credits: deps.maxCredits
    }));
    const mediaId = generated?.jobs?.[0]?.mediaId;
    const item = generated?.result?.items?.find(i => i?.mediaId === mediaId) ?? generated?.result?.items?.[0];
    if (!mediaId || item?.state !== 'succeeded') {
      const reason = `Flow clip ${item?.state ?? 'missing'}${item?.error ? `: ${item.error}` : ''}`;
      await deps.fail(job.id, reason, classifyError(reason).cooldownMs);
      return { status: 'failed', error: reason };
    }
    const downloaded = parseToolResult(await deps.callTool(account, 'flow_download_media', {
      media_id: mediaId,
      out_dir: deps.outDir
    }));
    if (!downloaded?.path) throw new Error('Flow download returned no path');
    const bytes = await deps.readFile(downloaded.path);
    await deps.complete(job.id, bytes);
    return { status: 'done', mediaId, bytes: bytes.byteLength, quotedCredits: generated?.quotedCredits };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { cooldownMs } = classifyError(message);
    await deps.fail(job.id, message.slice(0, 500), cooldownMs);
    return { status: 'failed', error: message };
  }
}

/** Account whose Flow session lives in the user's own Chrome (attached over CDP, no separate profile). */
export function isChromeAccount(account) {
  return account?.profileDir === 'chrome';
}

/** Chrome writes "<port>\n<browser ws path>" to DevToolsActivePort when remote debugging is on. */
export function cdpUrlFromActivePort(content) {
  const [port, path] = String(content ?? '').split('\n').map(line => line.trim());
  if (!/^\d{2,5}$/.test(port ?? '') || !path?.startsWith('/devtools/browser/')) return undefined;
  return `ws://127.0.0.1:${port}${path}`;
}

/** "cdp:http://127.0.0.1:9333" -> a dedicated real Chrome started with --remote-debugging-port (no Allow prompt). */
export function cdpUrlForAccount(account) {
  const value = account?.profileDir ?? '';
  if (!value.startsWith('cdp:')) return undefined;
  const url = value.slice(4);
  return /^(https?|wss?):\/\/(127\.0\.0\.1|localhost):\d{2,5}(\/.*)?$/.test(url) ? url : undefined;
}

/** Instruction for Flow's agent composer: generate exactly the prompt, nothing more. */
export function agentMessage(job, duration) {
  const aspect = job.aspect === '16:9' ? '16:9' : '9:16';
  return [
    `Generate exactly one video (no images, no extra shots, no variations) in ${aspect} aspect ratio, ${duration} seconds long, with the Omni 1.1 Flash model and its native audio.`,
    'Use this prompt verbatim, do not rewrite it:',
    '',
    job.prompt
  ].join('\n');
}

/**
 * Current Flow UI routes every prompt through its agent, which asks to approve
 * the credit cost. Approve only when the quote is within maxCredits (enforced by
 * google-flow-mcp), otherwise reject so nothing is spent.
 */
async function agentJob(job, account, projectId, duration, deps) {
  const chat = parseToolResult(await deps.callTool(account, 'flow_agent_chat', {
    project_id: projectId,
    message: agentMessage(job, duration),
    new_session: true,
    max_credits: deps.maxCredits
  }));
  if (chat?.approval === 'awaiting') {
    await deps.callTool(account, 'flow_agent_respond', { project_id: projectId, answer: 'Reject' }).catch(() => {});
    const cost = chat.pendingPermission?.totalCost ?? '?';
    const reason = `Flow agent quote ${cost} credits is above the cap of ${deps.maxCredits}; rejected, nothing spent`;
    await deps.fail(job.id, reason, 0);
    return { status: 'failed', error: reason };
  }
  const mediaId = chat?.generatedMediaIds?.[0];
  if (!mediaId) {
    const reason = `Flow agent did not start a video (${String(chat?.reply ?? '').slice(0, 160)})`;
    await deps.fail(job.id, reason, classifyError(reason).cooldownMs);
    return { status: 'failed', error: reason };
  }
  const status = parseToolResult(await deps.callTool(account, 'flow_video_status', { media_ids: [mediaId], wait: true, timeout_sec: 900 }));
  const item = status?.items?.find(i => i?.mediaId === mediaId) ?? status?.items?.[0];
  if (item?.state !== 'succeeded') {
    const reason = `Flow clip ${status?.timedOut ? 'timed out' : item?.state ?? 'missing'}`;
    await deps.fail(job.id, reason, classifyError(reason).cooldownMs);
    return { status: 'failed', error: reason };
  }
  const downloaded = parseToolResult(await deps.callTool(account, 'flow_download_media', { media_id: mediaId, out_dir: deps.outDir }));
  if (!downloaded?.path) throw new Error('Flow download returned no path');
  const bytes = await deps.readFile(downloaded.path);
  await deps.complete(job.id, bytes);
  return { status: 'done', mediaId, bytes: bytes.byteLength };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function projectState(account, projectId, deps) {
  const p = parseToolResult(await deps.callTool(account, 'flow_get_project', { project_id: projectId })) ?? {};
  // media and generations describe the same items (generations carry `created`): merge by id.
  const byId = new Map();
  for (const m of [...(p.media ?? []), ...(p.generations ?? [])]) {
    if (m?.mediaId) byId.set(m.mediaId, { ...(byId.get(m.mediaId) ?? {}), ...m });
  }
  const media = [...byId.values()];
  return { characters: p.characters ?? [], media };
}

/** Make sure every character exists in the project (recreating it from its look if needed); returns their Flow ids. */
async function ensureCharacters(account, projectId, refs, deps) {
  const ids = [];
  for (const ref of refs ?? []) {
    const { characters } = await projectState(account, projectId, deps);
    let c = characters.find(x => String(x?.name ?? '').toLowerCase() === ref.name.toLowerCase());
    if (!c) {
      const created = parseToolResult(await deps.callTool(account, 'flow_create_character', { project_id: projectId, name: ref.name, portrait_prompt: ref.look }));
      c = created?.character ?? created;
    }
    if (!c?.id) throw new Error(`Flow did not create character ${ref.name}`);
    ids.push(c.id);
  }
  return ids;
}

/** One still / animated keyframe through the agent. Images are free in Flow; anything that asks for credits above the cap is rejected. */
export function storyMessage(job, duration) {
  const aspect = job.aspect === '16:9' ? '16:9' : '9:16';
  if (job.kind === 'image') {
    return [
      `Generate exactly one image (no video, no variations) in ${aspect} aspect ratio with Nano Banana.`,
      'Keep every attached character exactly as in their character reference. Use this prompt verbatim:', '', job.prompt
    ].join('\n');
  }
  return [
    `Generate exactly one video (no images, no extra shots, no variations) in ${aspect} aspect ratio, ${duration} seconds long, with the Omni 1.1 Flash model and its native audio.`,
    job.startFrame ? 'Use the attached image as the first frame and animate it; keep the characters, outfits, colours and style identical to it.' : '',
    // A painted keyframe has nothing outside it: a zoom-out makes the model invent a page border or a floral frame.
    job.startFrame ? 'Keep the framing of the image: do not zoom out or reveal anything beyond its edges; no border, no page edges, no decorative frame.' : '',
    'Use this prompt verbatim, do not rewrite it:', '', job.prompt
  ].filter(Boolean).join('\n');
}

async function storyJob(job, account, deps) {
  const projectId = await ensureProject(account, deps.callTool, projectTitleFor(job, deps.projectTitle ?? 'Nirmalab studio'));
  if (job.kind === 'character') {
    const ref = job.characters?.[0];
    if (!ref) throw new Error('character job without a character');
    const find = async () => (await projectState(account, projectId, deps)).characters
      .find(x => String(x?.name ?? '').toLowerCase() === ref.name.toLowerCase());
    let c = await find();
    let portrait = c?.portraitMediaId;
    if (!c) {
      const created = parseToolResult(await deps.callTool(account, 'flow_create_character', { project_id: projectId, name: ref.name, portrait_prompt: job.prompt }));
      c = created?.character ?? created;
      // Flow hands the generated portrait back separately; the character links it a bit later.
      portrait = c?.portraitMediaId ?? created?.portrait?.[0]?.mediaId;
    }
    for (let i = 0; c?.id && !portrait && i < (deps.pollTries ?? 12); i++) {
      await sleep(deps.pollMs ?? 15_000);
      portrait = (await find())?.portraitMediaId;
    }
    if (!c?.id || !portrait) throw new Error(`Flow character ${ref.name} has no portrait`);
    const downloaded = parseToolResult(await deps.callTool(account, 'flow_download_media', { media_id: portrait, out_dir: deps.outDir }));
    if (!downloaded?.path) throw new Error('Flow download returned no path');
    const bytes = await deps.readFile(downloaded.path);
    await deps.complete(job.id, bytes, { mediaId: portrait, flowCharacterId: c.id });
    return { status: 'done', mediaId: portrait, bytes: bytes.byteLength };
  }

  const isVideo = job.kind === 'video';
  // Flow's first-frame animation (I2V) takes a single start image and refuses extra character references
  // ("cannot incorporate additional character entities"); the approved keyframe already carries every character.
  const i2v = isVideo && Boolean(job.startFrame?.mediaId);
  const characterIds = i2v ? [] : await ensureCharacters(account, projectId, job.characters, deps);
  const before = new Set((await projectState(account, projectId, deps)).media.map(m => m?.mediaId));
  const startedAt = Date.now();
  const duration = [4, 6, 8, 10].includes(job.durationSec) ? job.durationSec : 6;
  const chat = parseToolResult(await deps.callTool(account, 'flow_agent_chat', {
    project_id: projectId,
    message: storyMessage(job, duration),
    new_session: true,
    ...(characterIds.length ? { character_ids: characterIds } : {}),
    ...(i2v ? { image_ids: [job.startFrame.mediaId] } : {}),
    max_credits: isVideo ? deps.maxCredits : 0
  }));
  if (chat?.approval === 'awaiting') {
    await deps.callTool(account, 'flow_agent_respond', { project_id: projectId, answer: 'Reject' }).catch(() => {});
    const reason = `Flow agent quote ${chat.pendingPermission?.totalCost ?? '?'} credits is above the cap of ${isVideo ? deps.maxCredits : 0}; rejected, nothing spent`;
    await deps.fail(job.id, reason, 0);
    return { status: 'failed', error: reason };
  }
  let mediaId = chat?.generatedMediaIds?.[0];
  // The agent stream sometimes drops the ids; the new media still lands in the project.
  for (let i = 0; !mediaId && i < (deps.pollTries ?? 20); i++) {
    const fresh = (await projectState(account, projectId, deps)).media
      .filter(m => m?.mediaId && !before.has(m.mediaId) && (isVideo ? !/image/i.test(String(m.kind ?? '')) : !/video/i.test(String(m.kind ?? ''))))
      // An interrupted earlier turn can still land media now; only accept what was created during this turn.
      .filter(m => !m.created || Date.parse(m.created) >= startedAt - 20_000);
    mediaId = fresh[0]?.mediaId;
    if (!mediaId) await sleep(deps.pollMs ?? 15_000);
  }
  if (!mediaId) {
    const reason = `Flow agent did not create the ${isVideo ? 'video' : 'image'} (${String(chat?.reply ?? '').slice(0, 160)})`;
    await deps.fail(job.id, reason, classifyError(reason).cooldownMs);
    return { status: 'failed', error: reason };
  }
  if (isVideo) {
    const status = parseToolResult(await deps.callTool(account, 'flow_video_status', { media_ids: [mediaId], wait: true, timeout_sec: 900 }));
    const item = status?.items?.find(i => i?.mediaId === mediaId) ?? status?.items?.[0];
    if (item?.state !== 'succeeded') {
      const reason = `Flow clip ${status?.timedOut ? 'timed out' : item?.state ?? 'missing'}`;
      await deps.fail(job.id, reason, classifyError(reason).cooldownMs);
      return { status: 'failed', error: reason };
    }
  }
  const caption = (await projectState(account, projectId, deps)).media.find(m => m?.mediaId === mediaId)?.caption;
  const downloaded = parseToolResult(await deps.callTool(account, 'flow_download_media', { media_id: mediaId, out_dir: deps.outDir }));
  if (!downloaded?.path) throw new Error('Flow download returned no path');
  const bytes = await deps.readFile(downloaded.path);
  await deps.complete(job.id, bytes, { mediaId, ...(caption ? { caption } : {}) });
  return { status: 'done', mediaId, bytes: bytes.byteLength };
}

/** Dedicated Flow Chrome the bridge drives (undefined = preflight disabled). */
export function preflightUrl(env) {
  if (env.FLOW_PREFLIGHT === 'off') return undefined;
  return env.FLOW_CDP_URL || 'http://127.0.0.1:9333';
}

/** True when that Chrome answers on its DevTools port — claim jobs only then, so takes aren't burnt. */
export async function cdpReady(url, fetchImpl = fetch, timeoutMs = 3000) {
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return !!response?.ok;
  } catch {
    return false;
  }
}

/** Dedicated-Chrome (`cdp:`) accounts whose credits the bridge reads on every heartbeat. Never the user's main Chrome (Allow prompts) or Playwright profiles (heavy, Google signs them out). */
export function accountsToProbe(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter(a => a && typeof a === 'object' && typeof a.id === 'string' && a.status !== 'error' && cdpUrlForAccount(a))
    .map(a => ({ id: a.id, label: a.label, profileDir: a.profileDir, ...(a.proxy ? { proxy: a.proxy } : {}) }));
}

/** Flow ids of a finished take, as upload headers (URI-encoded: captions are free text). */
export function resultHeaders(meta = {}) {
  const h = {};
  if (meta.mediaId) h['x-flow-media-id'] = encodeURIComponent(meta.mediaId);
  if (meta.caption) h['x-flow-caption'] = encodeURIComponent(String(meta.caption).slice(0, 200));
  if (meta.flowCharacterId) h['x-flow-character-id'] = encodeURIComponent(meta.flowCharacterId);
  return h;
}

/** Run a job while pinging every `everyMs` so the server keeps showing the bridge online during long renders. */
export async function whileAlive(run, ping, everyMs = 30_000) {
  const timer = setInterval(() => { void Promise.resolve().then(ping).catch(() => undefined); }, everyMs);
  try { return await run(); } finally { clearInterval(timer); }
}

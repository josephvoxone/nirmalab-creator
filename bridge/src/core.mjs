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
export async function processJob(claim, deps) {
  const { job, account } = claim;
  try {
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

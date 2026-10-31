import { ApiError } from '../../lib/api.js';
import type { ProviderId } from '../providers/providersClient.js';

export type FlowFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FlowAccount = {
  id: string;
  label: string;
  email: string;
  profileDir?: string;
  status: 'ready' | 'cooldown' | 'error' | string;
  creditsUsedToday: number;
  credits?: number;
  cooldownUntilMs?: number;
  lastError?: string;
};

export type FlowJob = {
  id: string;
  prompt: string;
  technique?: string;
  kind?: 'video' | 'image' | 'character';
  provider?: ProviderId;
  model?: string;
  aspect: '9:16' | '16:9';
  durationSec: number;
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  attempts: number;
  createdAtMs: number;
  finishedAtMs?: number;
  accountId?: string;
  bytes?: number;
  error?: string;
};

/**
 * What an operator sees of a job on `GET /api/admin/flow/jobs`: load and state, never the prompt, technique, group, characters or result.
 * (`GET /api/flow/jobs` is the caller's OWN list and keeps the full `FlowJob`.)
 */
export type AdminFlowJob = {
  id: string;
  kind: 'video' | 'image' | 'character';
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  provider: string;
  model?: string;
  accountId?: string;
  attempts: number;
  error?: string;
  ownerId?: string;
  ownerEmail?: string;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  credits: number;
  cancelled?: true;
};

export type FlowBridge = { bridgeId?: string; lastSeenMs?: number; online: boolean };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function request<T>(fetchImpl: FlowFetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }
  });
  const payload = (await readJson(response)) as { error?: { message?: string; code?: string } | string } | undefined;
  if (!response.ok) {
    const err = payload?.error;
    // ApiError keeps status + code so callers can tell a 402 BUDGET from other refusals.
    throw new ApiError(response.status, (typeof err === 'string' ? err : err?.message) ?? `Request failed (${response.status})`, typeof err === 'string' ? undefined : err?.code);
  }
  return payload as T;
}

export type JobInput = {
  prompt: string; technique?: string; aspect: '9:16' | '16:9'; durationSec: number; kind?: 'video' | 'image';
  /** Absent = Google Flow. */
  provider?: 'openrouter'; model?: string;
  /** Queue even when the OpenRouter balance looks too low (after a 402 BUDGET). */
  force?: boolean;
};

export function flowClient(baseUrl: string, fetchImpl: FlowFetch) {
  return {
    accounts: () => request<{ accounts: FlowAccount[]; bridge: FlowBridge }>(fetchImpl, `${baseUrl}/api/flow/accounts`),
    addAccount: (input: { label: string; email: string; profileDir?: string }) =>
      request<{ account: FlowAccount }>(fetchImpl, `${baseUrl}/api/flow/accounts`, { method: 'POST', body: JSON.stringify(input) }),
    removeAccount: (id: string) =>
      request<{ ok: boolean }>(fetchImpl, `${baseUrl}/api/flow/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** The signed-in user's own jobs (the server filters by owner; nothing of anybody else's arrives). */
    jobs: () => request<{ jobs: FlowJob[] }>(fetchImpl, `${baseUrl}/api/flow/jobs`),
    /** Admin only: queue load of every user, without content (for the system console, not for Studio). */
    adminJobs: () => request<{ jobs: AdminFlowJob[] }>(fetchImpl, `${baseUrl}/api/admin/flow/jobs`),
    createJob: (input: JobInput) =>
      request<{ job: FlowJob }>(fetchImpl, `${baseUrl}/api/flow/jobs`, { method: 'POST', body: JSON.stringify(input) }),
    fileUrl: (jobId: string) => `${baseUrl}/api/flow/jobs/${jobId}/file`
  };
}

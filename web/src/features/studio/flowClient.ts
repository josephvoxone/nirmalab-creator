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
  const payload = (await readJson(response)) as { error?: { message?: string } } | undefined;
  if (!response.ok) throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  return payload as T;
}

export function flowClient(baseUrl: string, fetchImpl: FlowFetch) {
  return {
    accounts: () => request<{ accounts: FlowAccount[]; bridge: FlowBridge }>(fetchImpl, `${baseUrl}/api/flow/accounts`),
    addAccount: (input: { label: string; email: string; profileDir?: string }) =>
      request<{ account: FlowAccount }>(fetchImpl, `${baseUrl}/api/flow/accounts`, { method: 'POST', body: JSON.stringify(input) }),
    removeAccount: (id: string) =>
      request<{ ok: boolean }>(fetchImpl, `${baseUrl}/api/flow/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    jobs: () => request<{ jobs: FlowJob[] }>(fetchImpl, `${baseUrl}/api/flow/jobs`),
    createJob: (input: { prompt: string; technique?: string; aspect: '9:16' | '16:9'; durationSec: number }) =>
      request<{ job: FlowJob }>(fetchImpl, `${baseUrl}/api/flow/jobs`, { method: 'POST', body: JSON.stringify(input) }),
    fileUrl: (jobId: string) => `${baseUrl}/api/flow/jobs/${jobId}/file`
  };
}

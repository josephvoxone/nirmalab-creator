export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type User = { id: string; email: string; isAdmin: boolean };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function requestJson<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }
  });
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) {
    const err = (payload as { error?: { message?: string; code?: string } } | undefined)?.error;
    throw new ApiError(response.status, err?.message ?? `Permintaan gagal (${response.status})`, err?.code);
  }
  return payload as T;
}

export const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body ?? {}) });

export function authApi(fetchImpl: FetchLike) {
  return {
    me: () => requestJson<{ user: User }>(fetchImpl, '/api/auth/me'),
    login: (email: string, password: string) => requestJson<{ user: User }>(fetchImpl, '/api/auth/login', post({ email, password })),
    logout: () => requestJson<{ ok: boolean }>(fetchImpl, '/api/auth/logout', post({})),
    peekInvite: (token: string) => requestJson<{ valid: boolean; email?: string }>(fetchImpl, `/api/auth/invites/peek?token=${encodeURIComponent(token)}`),
    acceptInvite: (token: string, email: string, password: string) =>
      requestJson<{ user: User }>(fetchImpl, '/api/auth/invites/accept', post({ token, email, password }))
  };
}

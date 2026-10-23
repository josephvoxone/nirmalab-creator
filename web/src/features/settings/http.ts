// lib/api.ts has no DELETE helper; keep the extra verb local to this feature.
export { post, requestJson, type FetchLike } from '../../lib/api.js';

export const del = (): RequestInit => ({ method: 'DELETE' });

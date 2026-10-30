import { post, requestJson, type FetchLike } from '../../lib/api.js';

export type VoiceSettings = { stability: number; similarityBoost: number; style: number; speed: number; speakerBoost: boolean };
export type DubSettings = { voiceId?: string; modelId: string; languageCode: string; voice: VoiceSettings; keepAmbient: boolean };
export type DubModel = { id: string; label: string; creditsPerChar: number; languageCode: boolean };
export type DubShotStatus = 'none' | 'queued' | 'running' | 'done' | 'stale' | 'failed';
export type DubShot = {
  shotId: string; sceneId?: string; text: string; textSource: 'narration' | 'override'; voiceId?: string; chars: number;
  status: DubShotStatus; skipped: boolean; tooLong: boolean; error?: string; seconds?: number; audio?: string;
};
export type DubState = {
  configured: boolean; settings: DubSettings; models: DubModel[]; shots: DubShot[];
  totals: { dubbable: number; done: number; stale: number; failed: number; active: number; chars: number };
};
export type DubPlan = { shotIds: string[]; chars: number; credits: number; modelId: string };
export type DubScope = { kind: 'all' } | { kind: 'scene'; sceneId: string } | { kind: 'shots'; shotIds: string[] };
export type Voice = { id: string; name: string; category?: string; gender?: string; age?: string; previewUrl?: string };
export type SettingsPatch = { voiceId?: string | null; modelId?: string; keepAmbient?: boolean; voice?: Partial<VoiceSettings> };

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const del = (): RequestInit => ({ method: 'DELETE' });

export function dubApi(fetchImpl: FetchLike) {
  const base = (id: string) => `/api/stories/${id}/dub`;
  return {
    state: (id: string) => requestJson<{ dub: DubState }>(fetchImpl, base(id)).then(r => r.dub),
    voices: () => requestJson<{ voices: Voice[] }>(fetchImpl, '/api/dub/voices').then(r => r.voices),
    settings: (id: string, patch: SettingsPatch) => requestJson<{ dub: DubState }>(fetchImpl, `${base(id)}/settings`, put(patch)).then(r => r.dub),
    setShot: (id: string, shotId: string, patch: { text?: string | null; voiceId?: string | null }) => requestJson<{ dub: DubState }>(fetchImpl, `${base(id)}/shots/${shotId}`, put(patch)).then(r => r.dub),
    removeShot: (id: string, shotId: string) => requestJson<{ dub: DubState }>(fetchImpl, `${base(id)}/shots/${shotId}`, del()).then(r => r.dub),
    plan: (id: string, scope: DubScope, force = false) => requestJson<{ plan: DubPlan }>(fetchImpl, `${base(id)}/plan`, post(force ? { scope, force } : { scope })).then(r => r.plan),
    render: (id: string, scope: DubScope, confirmCredits: number, force = false) => requestJson<{ dub: DubState }>(fetchImpl, `${base(id)}/render`, post({ scope, confirmCredits, ...(force ? { force } : {}) })).then(r => r.dub),
    cancel: (id: string) => requestJson<{ dub: DubState }>(fetchImpl, `${base(id)}/cancel`, post({})).then(r => r.dub),
    audioUrl: (id: string, shotId: string, v = '') => `${base(id)}/shots/${shotId}/audio${v ? `?v=${v}` : ''}`
  };
}

export const STATUS_TEXT: Record<DubShotStatus, string> = { none: 'Belum', queued: 'Antre', running: 'Diproses', done: 'Siap', stale: 'Perlu ulang', failed: 'Gagal' };
export const fmtCredits = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 1 });

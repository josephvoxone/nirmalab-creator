import { post, put, requestJson, type FetchLike } from '../../lib/api.js';

export type StoryStatus = 'draft' | 'casting' | 'framing' | 'review' | 'rendering' | 'assembling' | 'done' | 'failed';
export type TakeState = { status: 'pending' | 'queued' | 'done' | 'failed'; attempts: number; mediaId?: string; caption?: string; lastError?: string; error?: string };
export type CastState = TakeState & { token: string; name: string };
export type ShotState = { id: string; frame?: TakeState; status: 'pending' | 'queued' | 'done' | 'failed'; attempts: number; jobId?: string; lastError?: string; error?: string; durationSec?: number };
export type Story = {
  id: string;
  title: string;
  status: StoryStatus;
  createdAtMs: number;
  updatedAtMs: number;
  mode?: 'konsisten' | 'cepat';
  cast?: CastState[];
  shots: ShotState[];
  error?: string;
  video?: { bytes: number; finishedAtMs: number };
  /** The final video predates the latest storyboard edit (order/content): re-assemble. */
  videoStale?: boolean;
  events: Array<{ atMs: number; message: string }>;
};
export type StoryboardShot = { id: string; prompt: string; narration?: string; silent?: boolean; reuse?: { jobId: string; start?: number } };
export type Storyboard = { title: string; shots: StoryboardShot[]; [key: string]: unknown };

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', casting: 'Membuat karakter', framing: 'Membuat keyframe', review: 'Siap direview', rendering: 'Dirender', assembling: 'Dirakit', done: 'Selesai', failed: 'Gagal',
  pending: 'Menunggu', queued: 'Antre/render'
};

export const STYLES: Array<{ label: string; value: string }> = [
  { label: 'Dongeng cat air', value: 'Style: hand-painted storybook illustration come alive, warm and gentle, soft watercolor textures, cinematic lighting, gentle film grain.' },
  { label: 'Animasi 3D lucu', value: 'Style: polished 3D animated feature film look, soft subsurface skin, expressive eyes, warm cinematic lighting, shallow depth of field.' },
  { label: 'Drama sinematik', value: 'Style: live-action cinematic drama, natural skin texture, anamorphic 35mm look, motivated practical lighting, subtle film grain.' },
  { label: 'Anime', value: 'Style: hand-drawn Japanese anime film look, painted backgrounds, soft cel shading, gentle bloom, cinematic composition.' }
];

export const CREDITS_PER_SHOT = 10;
export const isActive = (s: Pick<Story, 'status'>) => ['casting', 'framing', 'rendering', 'assembling'].includes(s.status);
export const doneCount = (s: Story) => s.shots.filter(x => x.status === 'done').length;
export const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;

export function storiesApi(fetchImpl: FetchLike) {
  return {
    list: () => requestJson<{ stories: Story[] }>(fetchImpl, '/api/stories'),
    get: (id: string) => requestJson<{ story: Story; storyboard: Storyboard }>(fetchImpl, `/api/stories/${id}`),
    catalog: () => requestJson<{ catalog: import('./catalog.js').Catalog; covers?: import('./catalog.js').Covers }>(fetchImpl, '/api/stories/catalog'),
    regenerateCover: (templateId: string) => requestJson<{ cover: unknown }>(fetchImpl, `/api/stories/templates/${templateId}/cover`, post({})),
    coverUrl: (templateId: string, v = 0) => `/api/stories/templates/${templateId}/cover?v=${v}`,
    prepare: (id: string, scene?: string) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/prepare`, post(scene ? { scene } : {})),
    assemble: (id: string) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/assemble`, post({})),
    setLook: (id: string, look: Record<string, string>) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/look`, post({ look })),
    redraw: (id: string, shotId: string, prompt?: string) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/shots/${shotId}/frame`, post(prompt ? { prompt } : {})),
    frameUrl: (id: string, shotId: string, v = '') => `/api/stories/${id}/shots/${shotId}/frame${v ? `?v=${v}` : ''}`,
    castUrl: (id: string, token: string) => `/api/stories/${id}/cast/${token}/image`,
    draft: (input: { premise: string; shots: number; style?: string; template?: string; look?: Record<string, string>; mode?: string; aspect?: string; engine?: import('../providers/providersClient.js').EngineSet }) => requestJson<{ story: Story }>(fetchImpl, '/api/stories/draft', post(input)),
    create: (storyboard: Storyboard) => requestJson<{ story: Story }>(fetchImpl, '/api/stories', post({ storyboard })),
    update: (id: string, storyboard: Storyboard) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}`, put({ storyboard })),
    render: (id: string, force: boolean, scope: { scene?: string; shot?: string } = {}) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/render`, post({ force, ...scope })),
    retry: (id: string) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/retry`, post({})),
    remove: (id: string) => requestJson<{ ok: boolean }>(fetchImpl, `/api/stories/${id}`, { method: 'DELETE' }),
    videoUrl: (id: string) => `/api/stories/${id}/video`,
    shotUrl: (id: string, shotId: string) => `/api/stories/${id}/shots/${shotId}/video`
  };
}

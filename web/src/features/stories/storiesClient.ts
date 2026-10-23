import { post, put, requestJson, type FetchLike } from '../../lib/api.js';

export type StoryStatus = 'draft' | 'rendering' | 'assembling' | 'done' | 'failed';
export type ShotState = { id: string; status: 'pending' | 'queued' | 'done' | 'failed'; attempts: number; jobId?: string; lastError?: string; error?: string; durationSec?: number };
export type Story = {
  id: string;
  title: string;
  status: StoryStatus;
  createdAtMs: number;
  updatedAtMs: number;
  shots: ShotState[];
  error?: string;
  video?: { bytes: number; finishedAtMs: number };
  events: Array<{ atMs: number; message: string }>;
};
export type StoryboardShot = { id: string; prompt: string; narration?: string; silent?: boolean; reuse?: { jobId: string; start?: number } };
export type Storyboard = { title: string; shots: StoryboardShot[]; [key: string]: unknown };

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', rendering: 'Dirender', assembling: 'Dirakit', done: 'Selesai', failed: 'Gagal',
  pending: 'Menunggu', queued: 'Antre/render'
};

export const STYLES: Array<{ label: string; value: string }> = [
  { label: 'Dongeng cat air', value: 'Style: hand-painted storybook illustration come alive, warm and gentle, soft watercolor textures, cinematic lighting, gentle film grain.' },
  { label: 'Animasi 3D lucu', value: 'Style: polished 3D animated feature film look, soft subsurface skin, expressive eyes, warm cinematic lighting, shallow depth of field.' },
  { label: 'Drama sinematik', value: 'Style: live-action cinematic drama, natural skin texture, anamorphic 35mm look, motivated practical lighting, subtle film grain.' },
  { label: 'Anime', value: 'Style: hand-drawn Japanese anime film look, painted backgrounds, soft cel shading, gentle bloom, cinematic composition.' }
];

export const CREDITS_PER_SHOT = 10;
export const isActive = (s: Pick<Story, 'status'>) => s.status === 'rendering' || s.status === 'assembling';
export const doneCount = (s: Story) => s.shots.filter(x => x.status === 'done').length;
export const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;

export function storiesApi(fetchImpl: FetchLike) {
  return {
    list: () => requestJson<{ stories: Story[] }>(fetchImpl, '/api/stories'),
    get: (id: string) => requestJson<{ story: Story; storyboard: Storyboard }>(fetchImpl, `/api/stories/${id}`),
    draft: (input: { premise: string; shots: number; style: string }) => requestJson<{ story: Story }>(fetchImpl, '/api/stories/draft', post(input)),
    create: (storyboard: Storyboard) => requestJson<{ story: Story }>(fetchImpl, '/api/stories', post({ storyboard })),
    update: (id: string, storyboard: Storyboard) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}`, put({ storyboard })),
    render: (id: string, force: boolean) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/render`, post({ force })),
    retry: (id: string) => requestJson<{ story: Story }>(fetchImpl, `/api/stories/${id}/retry`, post({})),
    remove: (id: string) => requestJson<{ ok: boolean }>(fetchImpl, `/api/stories/${id}`, { method: 'DELETE' }),
    videoUrl: (id: string) => `/api/stories/${id}/video`,
    shotUrl: (id: string, shotId: string) => `/api/stories/${id}/shots/${shotId}/video`
  };
}

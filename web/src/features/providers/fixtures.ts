/** Test fixtures for the provider routes (docs/providers-and-media.md §1). */
import type { Models, Providers } from './providersClient.js';

export const MODELS: Models = {
  image: [
    { id: 'openai/gpt-image-1', name: 'GPT Image 1', aspects: ['9:16', '16:9'], usdPerImage: 0.17, priceLabel: '±$0,17 / gambar', references: true },
    { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', aspects: ['9:16', '16:9'], usdPerImage: 0.04, priceLabel: '±$0,04 / gambar', references: true }
  ],
  video: [
    { id: 'google/veo-3.1', name: 'Veo 3.1', aspects: ['9:16', '16:9'], durations: [4, 6, 8], audio: true, firstFrame: true, usdPerClip: 2.4, priceLabel: '±$2,40 / klip 6 dtk' },
    { id: 'x/mystery', name: 'Mystery Video', aspects: ['16:9'], usdPerClip: null, priceLabel: 'harga belum diketahui' },
    { id: 'google/veo-3.1-lite', name: 'Veo 3.1 Lite', aspects: ['9:16', '16:9'], durations: [4, 6, 8], audio: true, firstFrame: true, usdPerClip: 0.3, priceLabel: '±$0,30 / klip 6 dtk' },
    { id: 'kling/kling-2', name: 'Kling 2', aspects: ['9:16', '16:9'], durations: [5, 10], audio: false, firstFrame: true, usdPerClip: 0.5, priceLabel: '±$0,50 / klip 5 dtk' }
  ]
};

export const CONFIGURED: Providers = {
  flow: { accounts: 3, credits: 450, online: true },
  openrouter: { configured: true, keyHint: '••••c0de', defaults: { image: 'google/gemini-2.5-flash-image', video: 'google/veo-3.1-lite' } },
  axcel: { configured: true, url: 'http://127.0.0.1:8899', tokenHint: '••••9f2a', health: { akun: 'joseph@example.com', plan: 'gold', planAktif: true, refMedia: true } }
};

export const UNCONFIGURED: Providers = {
  flow: { accounts: 2, credits: 120, online: false },
  openrouter: { configured: false, defaults: {} },
  axcel: { configured: false, url: 'http://127.0.0.1:8899' }
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers GET /api/providers + /models from fixtures; anything else → undefined (let the caller answer). */
export function providerResponse(url: string, init: RequestInit | undefined, providers: Providers | null = CONFIGURED): Response | undefined {
  const method = init?.method ?? 'GET';
  if (url.endsWith('/api/providers') && method === 'GET') return providers ? json(200, providers) : json(403, { error: { message: 'Admin only' } });
  if (url.endsWith('/api/providers/openrouter/models') && method === 'GET') return json(200, MODELS);
  return undefined;
}

import { vi } from 'vitest';

export type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

/** A fetch whose answers come from one function; unmatched URLs are a 404 the test can see. */
export function fakeFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(url, init) ?? { status: 404, body: { error: { message: `no fake for ${init?.method ?? 'GET'} ${url}` } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
}

export const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
export const ok = (body: unknown) => ({ status: 200, body });
export const fail = (status: number, message: string) => ({ status, body: { error: { message } } });

export const admin = { id: 'u1', email: 'joseph@nirmalab.com', isAdmin: true };
export const member = { id: 'u2', email: 'tim@nirmalab.com', isAdmin: false };

const look = { style: 'storybook', genre: 'drama', era: 'auto', camera: 'auto', lens: 'auto', aperture: 'auto', palette: 'auto', lighting: 'auto', tempo: 'mengalir' };
export const TEMPLATES = [
  { id: 'drama-hewan', category: 'drama', name: 'Drama Hewan', tagline: 'Kisah sedih hewan peliharaan', mode: 'konsisten', aspect: '9:16', narrator: 'hangat', example: 'Kucing oranye bernama Jingga menunggu di pagar.', cover: 'cat', look },
  { id: 'dongeng-anak', category: 'anak', name: 'Dongeng Tidur', tagline: 'Cerita lembut pengantar tidur', mode: 'konsisten', aspect: '9:16', narrator: 'anak', example: 'Bintang kecil bernama Kerlip takut gelap.', cover: 'star', look },
  { id: 'fakta-faceless', category: 'faceless', name: 'Fakta Faceless', tagline: 'Fakta singkat dengan b-roll', mode: 'cepat', aspect: '9:16', narrator: 'netral', example: 'Lima fakta tentang laut dalam.', cover: 'sea', look },
  { id: 'promo-produk', category: 'promo', name: 'Promo Produk', tagline: 'Iklan pendek UMKM', mode: 'cepat', aspect: '9:16', narrator: 'netral', example: 'Kopi susu gula aren dari warung kecil.', cover: 'coffee', look }
];
export const CATALOG = {
  templates: TEMPLATES, styles: [{ id: 'storybook', label: 'Storybook', prompt: 's' }], genres: [], eras: [], tempos: [{ id: 'mengalir', label: 'Mengalir', prompt: 't', shots: 8 }],
  cameras: [], lenses: [], apertures: [], palettes: [], lighting: [], framings: [], moves: []
};

export const STORIES = [
  { id: 'story_a', status: 'review', title: 'Jingga di Pagar', createdAtMs: 2, updatedAtMs: 3, shots: [] },
  { id: 'story_b', status: 'done', title: 'Kerlip dan Bulan', createdAtMs: 1, updatedAtMs: 1, shots: [] }
];

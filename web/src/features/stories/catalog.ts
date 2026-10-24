/** Studio picker catalog (served by GET /api/stories/catalog) + pure prompt helpers. */
import { useEffect, useState } from 'react';

export type Option = { id: string; label: string; hint?: string; prompt: string };
export type Palette = Option & { swatches: string[] };
export type Tempo = Option & { shots: number };
export type LookKey = 'style' | 'genre' | 'era' | 'camera' | 'lens' | 'aperture' | 'palette' | 'lighting' | 'tempo';
export type Look = Record<LookKey, string>;
export type Template = { id: string; name: string; tagline: string; mode: 'konsisten' | 'cepat'; aspect: '9:16' | '16:9'; narrator: string; example: string; look: Look };
export type Catalog = {
  templates: Template[]; styles: Option[]; genres: Option[]; eras: Option[]; tempos: Tempo[];
  cameras: Option[]; lenses: Option[]; apertures: Option[]; palettes: Palette[]; lighting: Option[];
  framings: Option[]; moves: Option[];
};

export type CoverState = { pending: boolean; error?: string; updatedAtMs?: number };
export type Covers = Record<string, CoverState>;

export const DEFAULT_LOOK: Look = { style: 'storybook', genre: 'auto', era: 'auto', camera: 'auto', lens: 'auto', aperture: 'auto', palette: 'auto', lighting: 'auto', tempo: 'mengalir' };

export const LIST_OF: Record<LookKey, keyof Catalog> = {
  style: 'styles', genre: 'genres', era: 'eras', camera: 'cameras', lens: 'lenses', aperture: 'apertures', palette: 'palettes', lighting: 'lighting', tempo: 'tempos'
};

export function optionOf(catalog: Catalog, key: LookKey, id: string | undefined): Option | undefined {
  return (catalog[LIST_OF[key]] as Option[]).find(o => o.id === id);
}

export function useCatalog(load: () => Promise<{ catalog: Catalog; covers?: Covers }>, pollMs = 8000) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [covers, setCovers] = useState<Covers>({});
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then(r => { if (alive) { setCatalog(r.catalog); setCovers(r.covers ?? {}); } }, e => alive && setError(e instanceof Error ? e.message : 'Gagal memuat katalog'));
    return () => { alive = false; };
  }, [load, tick]);
  const pending = Object.values(covers).some(c => c.pending);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setTick(t => t + 1), pollMs);
    return () => clearInterval(timer);
  }, [pending, pollMs]);
  return { catalog, covers, error, reload: () => setTick(t => t + 1) };
}

const SETUP = /^\s*[^.]*\bthe camera\b[^.]*\.\s*/i;

/** Which framing + move the shot's first sentence uses (ids), if it matches the catalog. */
export function readSetup(prompt: string, catalog: Pick<Catalog, 'framings' | 'moves'>): { framing?: string; move?: string } {
  const first = prompt.match(SETUP)?.[0] ?? '';
  const framing = [...catalog.framings].sort((a, b) => b.prompt.length - a.prompt.length)
    .find(f => first.toLowerCase().startsWith(f.prompt.toLowerCase()))?.id;
  const move = [...catalog.moves].sort((a, b) => b.prompt.length - a.prompt.length)
    .find(m => first.toLowerCase().includes(m.prompt.toLowerCase()))?.id;
  return { ...(framing ? { framing } : {}), ...(move ? { move } : {}) };
}

/** Same rule as the server (looks.ts): replace "<framing>, the camera …." or prepend it. */
export function setShotSetup(prompt: string, catalog: Pick<Catalog, 'framings' | 'moves'>, framingId: string, moveId: string): string {
  const framing = catalog.framings.find(f => f.id === framingId) ?? catalog.framings[0]!;
  const move = catalog.moves.find(m => m.id === moveId) ?? catalog.moves[0]!;
  const rest = prompt.replace(SETUP, '').trim();
  const setup = `${framing.prompt}, ${move.prompt}.`;
  return rest ? `${setup} ${rest}` : setup;
}

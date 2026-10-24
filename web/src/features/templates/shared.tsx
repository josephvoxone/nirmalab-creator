import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Catalog, CoverState, Template } from '../stories/catalog.js';

export const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'drama', label: 'Drama' },
  { id: 'anak', label: 'Anak' },
  { id: 'faceless', label: 'Faceless' },
  { id: 'edukasi', label: 'Edukasi' },
  { id: 'horor', label: 'Horor' },
  { id: 'budaya', label: 'Budaya' },
  { id: 'promo', label: 'Promo' }
];

export type CatTemplate = Template & { category?: string; cover?: string };

export const coverUrl = (id: string, v = 0) => `/api/stories/templates/${id}/cover?v=${v}`;

/** The template picture: the app-made cover, or its palette as a gradient while there is none. */
export function TemplateCover(props: { template: CatTemplate; catalog?: Catalog; state?: CoverState; className?: string }) {
  const { template, catalog } = props;
  const src = coverUrl(template.id, props.state?.updatedAtMs ?? 0);
  const [failed, setFailed] = useState<string>();
  const palette = catalog?.palettes.find(p => p.id === template.look.palette);
  const swatches = palette?.swatches.length ? palette.swatches : ['#3f3f46', '#18181b'];
  return (
    <span className={cn('relative block overflow-hidden bg-muted', props.className)}
      style={{ background: `linear-gradient(140deg, ${swatches.join(', ')})` }}>
      {failed !== src && <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} className="absolute inset-0 size-full object-cover" />}
      {props.state?.pending && <span className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-[11px] text-white">Membuat cover…</span>}
    </span>
  );
}

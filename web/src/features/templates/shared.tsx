import { useState } from 'react';
import { cn } from '@/lib/utils';
import { sizedImg } from '../../lib/media.js';
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

/**
 * The template picture: the app-made cover, or its palette as a gradient while there is none.
 * `width` = rendered box width in CSS px (the server sends the matching `?w=` webp); small by
 * default because most uses are chips/icons.
 */
export function TemplateCover(props: { template: CatTemplate; catalog?: Catalog; state?: CoverState; className?: string; width?: number; height?: number }) {
  const { template, catalog } = props;
  const src = coverUrl(template.id, props.state?.updatedAtMs ?? 0);
  const w = props.width ?? 40;
  const img = sizedImg(src, w);
  const [failed, setFailed] = useState<string>();
  const palette = catalog?.palettes.find(p => p.id === template.look.palette);
  const swatches = palette?.swatches.length ? palette.swatches : ['#3f3f46', '#18181b'];
  return (
    <span className={cn('relative block overflow-hidden bg-muted', props.className)}
      style={{ background: `linear-gradient(140deg, ${swatches.join(', ')})` }}>
      {failed !== src && (
        <img src={img.src} srcSet={img.srcSet} width={w} height={props.height ?? w} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)}
          className="absolute inset-0 size-full object-cover" />
      )}
      {props.state?.pending && <span className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-[11px] text-white">Membuat cover…</span>}
    </span>
  );
}

/** Small outline rectangle in the template's proportion plus its label ("9:16", "16:9"). */
export function AspectMark(props: { aspect: string; className?: string }) {
  const [a, b] = props.aspect.split(':').map(Number);
  const r = a && b ? a / b : 9 / 16;
  const box = r >= 1 ? { width: 14, height: Math.max(6, Math.round(14 / r)) } : { width: Math.max(6, Math.round(13 * r)), height: 13 };
  return (
    <span aria-label={`Rasio ${props.aspect}`} title={`Rasio ${props.aspect}`} className={cn('inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground', props.className)}>
      <span aria-hidden="true" data-aspect-box="" className="block shrink-0 rounded-[2px] border border-current" style={{ width: `${box.width}px`, height: `${box.height}px` }} />
      <span aria-hidden="true">{props.aspect}</span>
    </span>
  );
}

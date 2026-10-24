/**
 * The six look families and their named variants — the web mirror of `server/src/bible/styles.ts`
 * (spec §4.1/§9.1). The picker reads this file, not the served catalog, so the same grammar and
 * labels appear in Buat baru, Breakdown and Studio even when the server is older.
 *
 * A variant carries the legacy `style` id it writes into `look.style`: every board saved before
 * the bible keeps composing the exact same "Style:" line, which is what keeps clips from being
 * re-rendered for free.
 */
export type LookFamilyId = 'film-real' | 'painterly' | 'cel-anime' | 'clay' | 'docu' | 'noir';
export type LookVariant = { id: string; label: string; hint: string; style: string; /** English style sentence (same text the server composes), for Studio's single-clip prompt. */ prompt: string };
export type LookFamily = { id: LookFamilyId; label: string; hint: string; variants: LookVariant[] };

export const LOOK_FAMILIES: LookFamily[] = [
  {
    id: 'film-real', label: 'Film realis', hint: 'Live-action sinema: kulit nyata, lensa anamorphic, cahaya termotivasi',
    variants: [{ id: 'cinematic-drama', label: 'Drama sinematik', hint: 'Sinema live-action, kulit nyata', style: 'live-action', prompt: 'photorealistic live-action cinema, natural skin texture, real locations' }]
  },
  {
    id: 'painterly', label: 'Ilustrasi lukis', hint: 'Lukisan tangan: cat air, kertas berlapis, ornamen Nusantara',
    variants: [
      { id: 'storybook', label: 'Storybook cat air', hint: 'Cat air buku cerita', style: 'storybook', prompt: 'hand-painted storybook illustration come alive, soft watercolor textures, gentle paper grain' },
      { id: 'papercut', label: 'Papercut', hint: 'Diorama kertas berlapis', style: 'papercut', prompt: 'layered papercut diorama animation, cut paper textures, soft drop shadows between layers' },
      { id: 'wayang', label: 'Wayang & batik', hint: 'Ilustrasi Nusantara', style: 'wayang', prompt: 'Indonesian wayang and batik inspired painted illustration, ornate patterns, warm earthy textures' }
    ]
  },
  {
    id: 'cel-anime', label: 'Animasi cel', hint: 'Garis tangan dan cel shading dengan latar yang dilukis',
    variants: [
      { id: 'anime-2d', label: 'Anime 2D', hint: 'Garis tangan, latar dilukis', style: 'anime-2d', prompt: 'hand-drawn 2D anime feature film look, painted backgrounds, clean line art, soft cel shading' },
      { id: 'comic', label: 'Komik', hint: 'Tinta tebal, halftone', style: 'comic', prompt: 'graphic novel illustration come alive, bold ink lines, halftone shading' }
    ]
  },
  {
    id: 'clay', label: 'Clay & mainan', hint: 'Stop-motion plastisin dan 3D bergaya mainan, tekstur buatan tangan',
    variants: [
      { id: 'pixar-3d', label: 'Animasi 3D', hint: 'Animasi 3D layar lebar', style: 'pixar-3d', prompt: 'high-quality 3D animated feature film look, expressive stylized characters, soft subsurface skin, detailed textures' },
      { id: 'lowpoly', label: 'Low poly', hint: '3D geometris pastel', style: 'lowpoly', prompt: 'soft low-poly 3D diorama, faceted geometry, gentle pastel lighting' },
      // The clay base (`clay:clay` in bible/styles.ts) — stop-motion plastisin.
      { id: 'clay', label: 'Claymation', hint: 'Plastisin stop-motion', style: 'claymation', prompt: 'stop-motion claymation, handmade plasticine characters with visible fingerprints, miniature handcrafted sets' }
    ]
  },
  {
    id: 'docu', label: 'Dokumenter', hint: 'Footage observasional, cahaya alami, tanpa gaya yang menonjol',
    // A family with no named variants is its own base (`docu:docu`).
    variants: [{ id: 'docu', label: 'Observasional', hint: 'Footage nyata, cahaya alami', style: 'documentary', prompt: 'photorealistic documentary footage, natural light, observational framing' }]
  },
  {
    id: 'noir', label: 'Noir', hint: 'Bayangan keras, kontras tinggi, monokrom',
    variants: [{ id: 'noir', label: 'Noir monokrom', hint: 'Monokrom kontras tinggi', style: 'noir', prompt: 'high-contrast black and white film noir, hard shadows, deep blacks, drifting smoke' }]
  }
];

export const ALL_VARIANTS: LookVariant[] = LOOK_FAMILIES.flatMap(f => f.variants);

export const familyById = (id: string | undefined): LookFamily | undefined => LOOK_FAMILIES.find(f => f.id === id);
export const variantById = (id: string | undefined): LookVariant | undefined => (id ? ALL_VARIANTS.find(v => v.id === id) : undefined);

/** Family of a legacy `look.style` id, so board lama shows the right family without a migration. */
export function familyOfStyle(style: string | undefined): LookFamily | undefined {
  return style ? LOOK_FAMILIES.find(f => f.variants.some(v => v.style === style)) : undefined;
}

export type LookPick = { family?: string; variant?: string; style?: string };

/**
 * Fill in family+variant from whatever the board (or an older server) has: an explicit pair wins,
 * otherwise the legacy `style` decides the family. Never invents a pair it cannot justify.
 */
export function readLookPick(look: LookPick | undefined): { family: LookFamily; variant: LookVariant } | undefined {
  if (!look) return undefined;
  const fromVariant = variantById(look.variant);
  const family = (fromVariant && familyById(look.family)?.variants.some(v => v.id === fromVariant.id) ? familyById(look.family) : undefined)
    ?? (fromVariant ? LOOK_FAMILIES.find(f => f.variants.includes(fromVariant)) : undefined)
    ?? familyOfStyle(look.style);
  const variant = fromVariant && family?.variants.includes(fromVariant) ? fromVariant : family?.variants.find(v => v.style === look.style) ?? family?.variants[0];
  return family && variant ? { family, variant } : undefined;
}

/** "Ilustrasi lukis · Storybook cat air" — one label for chips, summaries and buttons. */
export function lookLabel(look: LookPick | undefined, fallback = 'Gaya'): string {
  const pick = readLookPick(look);
  return pick ? `${pick.family.label} · ${pick.variant.label}` : fallback;
}

/** Patch that switches to a variant: family, variant and the legacy style id move together. */
export function variantPatch(family: LookFamily, variant: LookVariant): { family: string; variant: string; style: string } {
  return { family: family.id, variant: variant.id, style: variant.style };
}

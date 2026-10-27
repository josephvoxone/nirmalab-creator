/**
 * StyleBible: the visual half of the production bible (spec §4.1, §9.1).
 *
 * Six families are the grammar — stock, lens set, aperture, palette (hex + role), light,
 * grain, halation, composition, forbidden list, medium. Named variants keep the old studio
 * looks (storybook, papercut, wayang, comic, anime-2d, pixar-3d, lowpoly, cinematic-drama,
 * docu, noir) but must obey the family grammar.
 *
 * `styleSentence` is compiled from those fields, never hand-written, and is used VERBATIM in
 * every prompt of a shot list: the exact same sentence in every shot is what makes the look
 * consistent, and it is snapshot-tested so drift fails the build.
 *
 * Pure data + pure functions: no IO, no randomness, no dependency.
 */

export type LookId = 'film-real' | 'painterly' | 'cel-anime' | 'clay' | 'docu' | 'noir';
export type StyleMedium = 'photoreal' | 'illustration' | 'stop-motion' | 'cel';
export type PaletteRole = 'sky' | 'skin' | 'ground' | 'accent' | 'shadow';
export type CompositionRule = 'thirds' | 'centered' | 'low-horizon';

export type PaletteAnchor = { name: string; hex: string; use: PaletteRole };

export type StyleLight = { key: string; fill: string; rim: string; temp: string; bestHours: string[] };

/** A named look inside a family: same grammar, its own signature. */
export type StyleVariant = {
  id: string; label: string; extra: string;
  /** Pins the variant's own framing (e.g. a full-bleed page); absent = the family composition. */
  composition?: Partial<StyleBible['composition']>;
};

export type StyleBible = {
  id: LookId;
  version: number;
  label: string;
  family: LookId;
  /** The family itself (`variant === family`) or one of its named variants. */
  variant: string;
  tags: string[];
  medium: StyleMedium;
  /** Film stock / capture device: "Kodak Portra 400 emulation, 35mm, halation on highlights". */
  stock: string;
  lenses: string[];
  aperture: string;
  palette: PaletteAnchor[];
  light: StyleLight;
  grain: string;
  halation: string;
  composition: { rule: CompositionRule; headroom: string; negativeSpace: string };
  /** Never allowed in frame: text, logos, split-screen, plastic skin, extra fingers… */
  forbidden: string[];
  /** Lookdev frames (asset ids) that pin the tone; 1–3 images. */
  lookdevFrames: string[];
  variants: StyleVariant[];
  /** Locked sentence, used verbatim in every prompt. Compiled by compileStyleSentence. */
  styleSentence: string;
};

export const LOOK_IDS: LookId[] = ['film-real', 'painterly', 'cel-anime', 'clay', 'docu', 'noir'];

const MEDIUM_CLAUSE: Record<StyleMedium, string> = {
  photoreal: 'photoreal live-action cinema with natural skin texture and real locations',
  illustration: 'hand-painted illustration with visible brushwork on textured paper',
  cel: 'hand-drawn cel animation with clean ink line art and flat cel shading',
  'stop-motion': 'stop-motion miniature with handcrafted plasticine sets and visible tool marks'
};

const RULE_CLAUSE: Record<CompositionRule, string> = {
  thirds: 'the rule of thirds',
  centered: 'a centred composition',
  'low-horizon': 'a low horizon line'
};

/** `a`, `a and b`, `a, b and c` — deterministic Oxford-less list. */
function list(items: string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/**
 * One deterministic English sentence: stock, lenses, aperture, light (key/fill/rim/temp),
 * palette anchors with their role, grain, halation, medium, composition, the variant
 * signature and the forbidden list. No `. ` inside, so it never reads as two instructions.
 */
export function compileStyleSentence(look: Omit<StyleBible, 'styleSentence'>): string {
  const variant = look.variants.find(v => v.id === look.variant);
  const palette = look.palette.map(p => `${p.hex} (${p.use})`);
  // Locked per look, but deliberately free of per-shot facts (lens choice, light direction,
  // forbidden list) — those are emitted once by the compiler, so nothing is said twice.
  const parts = [
    `Shot on ${look.stock}`,
    `palette ${list(palette)}`,
    look.grain,
    // The stock already names its halation on several looks; never say it twice.
    /halation/i.test(look.stock) ? '' : look.halation,
    MEDIUM_CLAUSE[look.medium],
    `${RULE_CLAUSE[look.composition.rule]} framing, ${look.composition.headroom}, ${look.composition.negativeSpace}`,
    ...(variant ? [`in the ${variant.label.toLowerCase()} variant: ${variant.extra}`] : [])
  ];
  return `${parts.filter(Boolean).join(', ')}.`;
}

type FamilyDef = Omit<StyleBible, 'styleSentence'>;

const DEFINITIONS: FamilyDef[] = [
  {
    id: 'film-real',
    version: 1,
    label: 'Film real',
    family: 'film-real',
    variant: 'film-real',
    tags: ['drama', 'faceless', 'default'],
    medium: 'photoreal',
    stock: 'Kodak Portra 400 emulsion on 35mm with halation on practical highlights',
    lenses: ['24mm wide', '35mm', '50mm', '85mm portrait'],
    aperture: 'f/2.0–f/2.8 at shallow depth of field',
    palette: [
      { name: 'Langit Sore', hex: '#b7c7cf', use: 'sky' },
      { name: 'Kulit Hangat', hex: '#c98f6b', use: 'skin' },
      { name: 'Tanah Basah', hex: '#3f5f43', use: 'ground' },
      { name: 'Merah Gerbang', hex: '#a8322a', use: 'accent' },
      { name: 'Bayang Coklat', hex: '#241f1c', use: 'shadow' }
    ],
    light: {
      key: 'a soft north window key',
      fill: 'a bounced cream fill',
      rim: 'a warm doorway rim',
      temp: '3200 K tungsten with a daylight edge',
      bestHours: ['golden hour', 'late afternoon']
    },
    grain: 'fine organic 35mm grain',
    halation: 'gentle halation blooming around practical highlights',
    composition: { rule: 'thirds', headroom: 'generous headroom above the eyes', negativeSpace: 'a quiet strip of negative space on the shadow side' },
    forbidden: ['on-screen text', 'logos', 'watermarks', 'split-screen', 'plastic skin', 'extra fingers', 'warped faces'],
    lookdevFrames: [],
    variants: [
      { id: 'docu', label: 'Documentary', extra: 'observational handheld framing with available light and no staged blocking' },
      { id: 'cinematic-drama', label: 'Cinematic drama', extra: 'composed widescreen blocking and slow deliberate camera moves' }
    ]
  },
  {
    id: 'painterly',
    version: 1,
    label: 'Painterly',
    family: 'painterly',
    variant: 'painterly',
    tags: ['anak', 'dongeng'],
    medium: 'illustration',
    stock: 'gouache and watercolour on cold-press cotton paper scanned at 600 dpi',
    lenses: ['28mm wide', '35mm', '50mm'],
    aperture: 'f/4 with soft edges and a painterly falloff',
    palette: [
      { name: 'Krim Kertas', hex: '#f4ead8', use: 'sky' },
      { name: 'Kulit Tanah', hex: '#d9a066', use: 'skin' },
      { name: 'Hijau Lumut', hex: '#5b7a4a', use: 'ground' },
      { name: 'Merah Saga', hex: '#b3452f', use: 'accent' },
      { name: 'Coklat Tinta', hex: '#3a2a20', use: 'shadow' }
    ],
    light: {
      key: 'a warm afternoon window key',
      fill: 'a soft paper-bounce fill',
      rim: 'a thin ink-line rim',
      temp: '4500 K with a warm paper cast',
      bestHours: ['mid-morning', 'golden hour']
    },
    grain: 'visible paper tooth and pigment granulation',
    halation: 'watercolour blooms instead of lens halation',
    composition: { rule: 'centered', headroom: 'a generous painted sky above the heads', negativeSpace: 'an open wash of plain paper at the edges' },
    forbidden: ['on-screen text', 'logos', 'photographic skin texture', 'glossy 3D shading', 'hard vector edges'],
    lookdevFrames: [],
    variants: [
      { id: 'storybook', label: 'Storybook', extra: 'gouache washes, soft pencil underdrawing and rounded shapes for a children book' },
      { id: 'papercut', label: 'Papercut', extra: 'layered cut-paper diorama with soft drop shadows between the layers' },
      { id: 'wayang', label: 'Wayang', extra: 'Javanese wayang and batik ornament, flat ornate profiles and warm earthy pigment' },
      // Epic Bible stories: one fixed full-bleed page, so every frame is framed the same way
      // (the family's "open wash of paper" margin wanders from shot to shot).
      { id: 'alkitab', label: 'Alkitab bergambar', extra: 'rich gouache with oil-glaze depth like a classic illustrated Bible, luminous golden light, detailed painted backgrounds and an epic sense of scale',
        composition: { rule: 'thirds', headroom: 'the same clear headroom above every head', negativeSpace: 'a full-bleed painting that fills the frame edge to edge with no blank paper border' } }
    ]
  },
  {
    id: 'cel-anime',
    version: 1,
    label: 'Cel anime',
    family: 'cel-anime',
    variant: 'cel-anime',
    tags: ['anime', 'komik', 'drama'],
    medium: 'cel',
    stock: '35mm anime film-out with an optical composite and soft gate weave',
    lenses: ['24mm wide', '35mm', '85mm portrait'],
    aperture: 'f/2.8 with painted background bokeh',
    palette: [
      { name: 'Langit Musim Panas', hex: '#8ecae6', use: 'sky' },
      { name: 'Kulit Cerah', hex: '#f2c9a0', use: 'skin' },
      { name: 'Rumput', hex: '#6a994e', use: 'ground' },
      { name: 'Jingga Senja', hex: '#f28f3b', use: 'accent' },
      { name: 'Biru Malam', hex: '#1d3557', use: 'shadow' }
    ],
    light: {
      key: 'a hard afternoon sun key',
      fill: 'a cool sky bounce fill',
      rim: 'a bright edge rim from the horizon',
      temp: '5600 K daylight with cool shadows',
      bestHours: ['morning', 'sunset']
    },
    grain: 'fine optical film grain over the cel paint',
    halation: 'a soft bloom on the brightest highlights only',
    composition: { rule: 'low-horizon', headroom: 'wide open sky above the characters', negativeSpace: 'clean empty sky in the upper third' },
    forbidden: ['on-screen text', 'logos', 'photoreal skin', 'glossy 3D shading', 'western cartoon proportions'],
    lookdevFrames: [],
    variants: [
      { id: 'comic', label: 'Comic', extra: 'bold ink lines with halftone shading and limited spot colour' },
      { id: 'anime-2d', label: 'Anime 2D', extra: 'clean line art over hand-painted backgrounds with flat cel shading' }
    ]
  },
  {
    id: 'clay',
    version: 1,
    label: 'Clay',
    family: 'clay',
    variant: 'clay',
    tags: ['anak', 'komedi', 'edukasi'],
    medium: 'stop-motion',
    stock: '16mm stop-motion film-out on a hand-built miniature set',
    lenses: ['35mm macro', '50mm', '85mm'],
    aperture: 'f/5.6 at deep miniature focus',
    palette: [
      { name: 'Plastisin Krim', hex: '#f1e3c8', use: 'sky' },
      { name: 'Tanah Liat', hex: '#d18b5f', use: 'skin' },
      { name: 'Rumput Mini', hex: '#7ba05b', use: 'ground' },
      { name: 'Merah Balon', hex: '#cf3b2f', use: 'accent' },
      { name: 'Bayang Hangat', hex: '#2b2118', use: 'shadow' }
    ],
    light: {
      key: 'a small softbox key close to the set',
      fill: 'a white card fill',
      rim: 'a low backlight to separate the miniature',
      temp: '3400 K warm practical bulbs',
      bestHours: ['studio day', 'studio night']
    },
    grain: 'subtle 16mm grain over matte clay surfaces',
    halation: 'a faint warm halo around the practical bulbs',
    composition: { rule: 'thirds', headroom: 'short headroom that keeps the set visible', negativeSpace: 'a plain hand-painted backdrop' },
    forbidden: ['on-screen text', 'logos', 'smooth digital surfaces', 'photoreal fur', 'motion-blurred limbs'],
    lookdevFrames: [],
    variants: [
      { id: 'pixar-3d', label: 'Feature 3D', extra: 'feature-animation 3D with soft subsurface skin and expressive stylised faces' },
      { id: 'lowpoly', label: 'Low poly', extra: 'faceted low-poly geometry with flat pastel shading and simple shapes' }
    ]
  },
  {
    id: 'docu',
    version: 1,
    label: 'Documentary',
    family: 'docu',
    variant: 'docu',
    tags: ['faceless', 'edukasi', 'observational'],
    medium: 'photoreal',
    stock: 'a modern full-frame documentary camera with a 35mm prime and a minimal true-colour grade',
    lenses: ['24mm wide', '35mm', '70-200mm telephoto'],
    aperture: 'f/4 with deep focus on faces and background',
    palette: [
      { name: 'Langit Mendung', hex: '#c9d6d8', use: 'sky' },
      { name: 'Kulit Alami', hex: '#b98a63', use: 'skin' },
      { name: 'Tanah Kering', hex: '#8a7a5c', use: 'ground' },
      { name: 'Kuning Tenda', hex: '#e0b23c', use: 'accent' },
      { name: 'Bayang Dingin', hex: '#2e3a3c', use: 'shadow' }
    ],
    light: {
      key: 'flat overcast daylight',
      fill: 'the open sky as a soft fill',
      rim: 'no added rim, only natural separation',
      temp: '6500 K neutral daylight',
      bestHours: ['overcast noon', 'early morning']
    },
    grain: 'light digital noise with no added grain',
    halation: 'no halation, a clean highlight rolloff',
    composition: { rule: 'thirds', headroom: 'eye-level headroom as if handheld', negativeSpace: 'unframed edges that let the world continue off screen' },
    forbidden: ['on-screen text', 'logos', 'staged blocking', 'beauty lighting', 'teal and orange grade'],
    lookdevFrames: [],
    variants: []
  },
  {
    id: 'noir',
    version: 1,
    label: 'Noir',
    family: 'noir',
    variant: 'noir',
    tags: ['horor', 'misteri', 'monokrom'],
    medium: 'photoreal',
    stock: 'Kodak Double-X 5222 black and white on 35mm with heavy halation',
    lenses: ['28mm', '40mm', '75mm portrait'],
    aperture: 'f/2.8 with a hard falloff into black',
    palette: [
      { name: 'Hitam Tinta', hex: '#0b0b0b', use: 'shadow' },
      { name: 'Abu Asap', hex: '#5a5a5a', use: 'sky' },
      { name: 'Kulit Pucat', hex: '#cfc4b4', use: 'skin' },
      { name: 'Beton Malam', hex: '#2a2a2a', use: 'ground' },
      { name: 'Putih Lampu', hex: '#f2f0ea', use: 'accent' }
    ],
    light: {
      key: 'a single hard key from a high side angle',
      fill: 'almost no fill, one faint bounce',
      rim: 'a hard rim from a practical lamp',
      temp: '2900 K tungsten with deep black shadows',
      bestHours: ['night', 'rainy dusk']
    },
    grain: 'coarse black-and-white grain',
    halation: 'strong halation around every practical light',
    composition: { rule: 'low-horizon', headroom: 'tight headroom that traps the subject', negativeSpace: 'large areas of pure black negative space' },
    forbidden: ['on-screen text', 'logos', 'colour', 'flat lighting', 'smiling models'],
    lookdevFrames: [],
    variants: [{ id: 'noir', label: 'Noir', extra: 'venetian-blind shadows and smoke cutting the key light' }]
  }
];

/** The six families, each with its locked style sentence. */
export const LOOKS: StyleBible[] = DEFINITIONS.map(look => ({ ...look, styleSentence: compileStyleSentence(look) }));

const familyOf = (id: string) => LOOKS.find(look => look.id === id);

/**
 * Look by family id (`film-real`), by variant id (`wayang`), or by explicit
 * `family:variant` (`film-real:docu`). A family id always wins over a same-named variant,
 * so `docu` is the documentary family and `film-real:docu` is its variant.
 */
export function lookById(id: string): StyleBible | undefined {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (!raw) return undefined;
  const cut = raw.indexOf(':');
  if (cut >= 0) {
    const family = familyOf(raw.slice(0, cut).trim());
    const variantId = raw.slice(cut + 1).trim();
    // `family:family` is the family base, so `docu:docu` and `clay:clay` are well defined.
    if (family && variantId === family.id) return family;
    const variant = family?.variants.find(v => v.id === variantId);
    if (!family || !variant) return undefined;
    const look: StyleBible = { ...family, variant: variant.id, label: variant.label, ...(variant.composition ? { composition: { ...family.composition, ...variant.composition } } : {}) };
    return { ...look, styleSentence: compileStyleSentence(look) };
  }
  const family = familyOf(raw);
  if (family) return family;
  const owner = LOOKS.find(look => look.variants.some(v => v.id === raw));
  const variant = owner?.variants.find(v => v.id === raw);
  if (!owner || !variant) return undefined;
  const look: StyleBible = { ...owner, variant: variant.id, label: variant.label };
  return { ...look, styleSentence: compileStyleSentence(look) };
}

/**
 * Old studio styles (the 10 ids in `CATALOG.styles`, still stored on legacy boards) →
 * the family + variant that carries the same intent. No board is re-prompted by this map:
 * boards without a `bible` keep their stored `style` string byte for byte.
 */
export const LEGACY_STYLE_MAP: Record<string, { family: LookId; variant: string }> = {
  storybook: { family: 'painterly', variant: 'storybook' },
  papercut: { family: 'painterly', variant: 'papercut' },
  wayang: { family: 'painterly', variant: 'wayang' },
  alkitab: { family: 'painterly', variant: 'alkitab' },
  comic: { family: 'cel-anime', variant: 'comic' },
  'anime-2d': { family: 'cel-anime', variant: 'anime-2d' },
  'pixar-3d': { family: 'clay', variant: 'pixar-3d' },
  lowpoly: { family: 'clay', variant: 'lowpoly' },
  claymation: { family: 'clay', variant: 'clay' },
  'live-action': { family: 'film-real', variant: 'cinematic-drama' },
  documentary: { family: 'docu', variant: 'docu' },
  noir: { family: 'noir', variant: 'noir' }
};

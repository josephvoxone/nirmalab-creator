import { composePrompt, techniqueKey, type Technique } from './compose.js';

export type PresetGroup = 'drama' | 'kids' | 'faceless' | 'genre' | 'viral';

export type StylePreset = {
  id: string;
  name: string;
  group: PresetGroup;
  description: string;
  /** technique keys "category/slug"; camera first, max one camera-movement */
  techniques: string[];
  /** style/grade line appended as "Style: …" */
  style: string;
  /** noun list, rendered as "Negative prompt: a, b" (Vertex guidance: list, not "no …") */
  negative: string[];
  aspect: '9:16' | '16:9';
  durationSec: 4 | 6 | 8;
  /** optional identical character descriptor for multi-shot consistency */
  character?: string;
  subjectExample: string;
  /** technique whose sample video/still represents the preset */
  previewKey: string;
  /**
   * Curated rewrites of catalog templates whose generic wording leaks into
   * unrelated scenes (e.g. the dappled-light template mentions a horse).
   */
  overrides?: Record<string, string>;
};

const SOFT_LIGHT_OBJECT = 'Soft wrapping light on [Subject] from a large source, gentle shadow transitions.';

export const PRESET_GROUPS: Array<{ key: PresetGroup; label: string }> = [
  { key: 'drama', label: 'Drama' },
  { key: 'kids', label: 'Anak' },
  { key: 'faceless', label: 'Faceless' },
  { key: 'genre', label: 'Genre look' },
  { key: 'viral', label: 'Viral look' }
];

/** Veo adds gibberish subtitles unless told (MIT Tech Review; OpenMicroDrama negative list). */
export const DEFAULT_NEGATIVE = [
  'subtitles', 'captions', 'on-screen text', 'watermark', 'logos', 'warped hands',
  // Veo renders gear named in camera-move templates literally (a jib arm appeared in frame).
  'camera equipment', 'camera crane', 'film crew', 'drone in frame'
];

export const CURATED_PRESETS: StylePreset[] = [
  {
    id: 'drama-intimate-dialogue',
    name: 'Dialog intim',
    group: 'drama',
    description: 'Medium close-up (65–75mm), push-in pelan, Rembrandt, grade amber hangat. Untuk pengakuan, rayuan, perpisahan.',
    techniques: ['framing/medium-close-up', 'camera-movement/push-in', 'lighting/rembrandt', 'color/warm-amber'],
    style: 'naturalistic performance, shallow depth of field, soft fine film grain',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 6,
    character: 'a woman in her late twenties, shoulder-length black hair, cream knit sweater',
    subjectExample: 'she quietly admits the truth, eyes glistening, then looks down',
    previewKey: 'camera-movement/push-in'
  },
  {
    id: 'drama-confrontation',
    name: 'Konfrontasi tegang',
    group: 'drama',
    description: 'Close-up, sudut rendah, low-key keras, warna desaturasi. Untuk adu argumen dan ancaman.',
    techniques: ['framing/close-up', 'camera-angles/low-angle', 'camera-movement/handheld', 'lighting/low-key', 'color/desaturation'],
    style: 'tense, handheld micro-shake, high contrast, gritty texture',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 4,
    character: 'a man in his forties, stubble, rain-damp grey suit, loosened tie',
    subjectExample: 'he leans in and slams his palm on the table',
    previewKey: 'camera-movement/handheld'
  },
  {
    id: 'drama-flashback',
    name: 'Flashback kenangan',
    group: 'drama',
    description: 'Cahaya jendela, debu melayang, grade pudar + halation. Untuk memori masa kecil dan nostalgia.',
    techniques: ['framing/wide-shot', 'camera-movement/slider', 'lighting/window-light', 'atmosphere/dust-motes', 'color/filmic-faded', 'effects/halation'],
    style: 'dreamy memory, soft bloom on highlights, gentle 16mm grain',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 6,
    character: 'a young girl and her grandmother',
    subjectExample: 'fold laundry together in a sunlit wooden house',
    previewKey: 'camera-movement/slider'
  },
  {
    id: 'drama-twist-reveal',
    name: 'Plot twist / reveal',
    group: 'drama',
    description: 'Dolly zoom (efek Vertigo), extreme close-up, cahaya keras, grade biru dingin. Untuk momen sadar/terbongkar.',
    techniques: ['framing/extreme-close-up', 'camera-movement/dolly-zoom', 'lighting/hard-light', 'color/cool-blue'],
    style: 'sudden dread, background warping while the face holds, crisp detail',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 4,
    character: 'a young man in a wrinkled white shirt',
    subjectExample: 'realizes the old photo on the wall shows himself as a stranger',
    previewKey: 'camera-movement/dolly-zoom'
  },
  {
    id: 'drama-microdrama-night',
    name: 'Micro-drama kota malam',
    group: 'drama',
    description: 'Medium shot walk-and-talk, neon praktikal, teal-orange. Gaya serial drama vertikal 9:16.',
    techniques: ['framing/medium-shot', 'camera-movement/walk-and-talk', 'lighting/neon-practical', 'color/teal-orange'],
    style: 'glossy vertical micro-drama, wet streets, bokeh city lights',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 6,
    character: 'a young couple, she in a red trench coat, he in a black leather jacket',
    subjectExample: 'they argue while walking fast through a rainy night market',
    previewKey: 'camera-movement/walk-and-talk'
  },
  {
    id: 'kids-3d-cute',
    name: 'Animasi 3D lucu',
    group: 'kids',
    description: 'Eye level, arc lembut, cahaya lembut, warna saturasi tinggi, tampilan animasi. Untuk cerita anak dan maskot.',
    techniques: ['camera-angles/eye-level', 'camera-movement/arc', 'lighting/soft-light', 'color/hyper-saturation', 'genre-looks/animation'],
    style: 'high-quality 3D animated family film look, rounded shapes, expressive big eyes, pastel palette, playful',
    negative: [...DEFAULT_NEGATIVE, 'scary imagery', 'realistic gore'],
    aspect: '9:16',
    durationSec: 6,
    overrides: { 'lighting/soft-light': SOFT_LIGHT_OBJECT },
    character: 'a small round orange cat with a blue backpack and huge curious eyes',
    subjectExample: 'it discovers a glowing snail in the garden and giggles',
    previewKey: 'camera-movement/arc'
  },
  {
    id: 'kids-storybook',
    name: 'Dongeng buku cerita',
    group: 'kids',
    description: 'Wide shot, jib naik pelan, cahaya menembus daun, dunia kastil dongeng. Untuk pembuka cerita sebelum tidur.',
    techniques: ['framing/wide-shot', 'camera-movement/jib', 'lighting/dappled-light', 'viral-looks/fairytale-castle'],
    style: 'hand-painted storybook illustration come alive, warm and gentle, soft watercolor textures',
    negative: [...DEFAULT_NEGATIVE, 'scary imagery'],
    aspect: '9:16',
    durationSec: 6,
    overrides: {
      'camera-movement/jib': 'The camera rises gently a few feet above [Subject] in one smooth sweeping lift.',
      'lighting/dappled-light': 'Sun through leaves on [Subject], irregular patches of brightness and leaf-shaped shadows.'
    },
    character: 'a little rabbit in a red scarf',
    subjectExample: 'hops toward a tiny castle on a hill',
    previewKey: 'viral-looks/fairytale-castle'
  },
  {
    id: 'kids-learning',
    name: 'Edukasi ceria',
    group: 'kids',
    description: 'Komposisi tengah, kamera terkunci, high-key terang. Untuk lagu anak, berhitung, mengenal warna.',
    techniques: ['composition/centered-composition', 'camera-movement/fixed-cam', 'lighting/high-key', 'composition/clean-frame'],
    style: 'bright cheerful 3D cartoon set, primary colors, clean background, friendly',
    negative: [...DEFAULT_NEGATIVE, 'scary imagery'],
    aspect: '9:16',
    durationSec: 4,
    overrides: { 'composition/centered-composition': 'Dead-center composition of [Subject], bilateral symmetry, frontal and playful.' },
    character: 'three round balloons in red, yellow and blue',
    subjectExample: 'pop up one by one and bounce happily',
    previewKey: 'composition/centered-composition'
  },
  {
    id: 'kids-miniature',
    name: 'Petualangan miniatur',
    group: 'kids',
    description: 'Tilt-shift + diorama: dunia mainan kecil yang terasa besar.',
    techniques: ['lenses/tilt-shift', 'effects/diorama', 'lighting/soft-light'],
    style: 'toy-like miniature world, tiny handcrafted details, cheerful daylight',
    negative: [...DEFAULT_NEGATIVE, 'scary imagery'],
    aspect: '9:16',
    durationSec: 4,
    overrides: { 'lighting/soft-light': SOFT_LIGHT_OBJECT },
    character: 'a toy train carrying fruit',
    subjectExample: 'crosses a tiny bridge over a puddle',
    previewKey: 'effects/diorama'
  },
  {
    id: 'faceless-broll-doc',
    name: 'B-roll dokumenter',
    group: 'faceless',
    description: 'Establishing shot, slider, cahaya alami, grade natural. B-roll untuk narasi voice-over tanpa wajah.',
    techniques: ['framing/establishing-shot', 'camera-movement/slider', 'lighting/available-light', 'color/natural-grade', 'genre-looks/documentary-look'],
    style: 'observational documentary, real textures, calm pacing',
    negative: [...DEFAULT_NEGATIVE, 'faces', 'people looking at camera'],
    aspect: '9:16',
    durationSec: 6,
    overrides: { 'color/natural-grade': 'Natural grade on [Subject], faithful colors, restrained saturation.' },
    character: 'an early-morning traditional market in Jakarta',
    subjectExample: 'steam rises from food stalls as vendors set up',
    previewKey: 'camera-movement/slider'
  },
  {
    id: 'faceless-hands-pov',
    name: 'Tutorial tangan / POV',
    group: 'faceless',
    description: 'First-person, insert, frame bersih, cahaya lembut. Untuk masak, kerajinan, unboxing.',
    techniques: ['camera-angles/first-person', 'framing/insert', 'composition/clean-frame', 'lighting/soft-light'],
    style: 'top-quality tutorial footage, satisfying precise hand movements, tidy workspace',
    negative: [...DEFAULT_NEGATIVE, 'faces'],
    aspect: '9:16',
    durationSec: 4,
    overrides: {
      'lighting/soft-light': SOFT_LIGHT_OBJECT,
      'camera-angles/first-person': 'First-person point of view looking down, [Subject] entering from the bottom edge of frame.'
    },
    character: 'two hands',
    subjectExample: 'slice a ripe mango into a neat hedgehog pattern',
    previewKey: 'camera-angles/first-person'
  },
  {
    id: 'faceless-mystery',
    name: 'Misteri / horor',
    group: 'faceless',
    description: 'Kamera terkunci, kabut, low-key, nuansa cosmic horror. Untuk kanal cerita misteri.',
    techniques: ['camera-movement/fixed-cam', 'atmosphere/fog', 'lighting/low-key', 'genre-looks/cosmic-horror-look'],
    style: 'slow creeping dread, muted cold palette, deep shadows',
    negative: [...DEFAULT_NEGATIVE, 'faces', 'gore'],
    aspect: '9:16',
    durationSec: 6,
    character: 'an abandoned wooden house at the edge of a rice field',
    subjectExample: 'at night a single window flickers',
    previewKey: 'atmosphere/fog'
  },
  {
    id: 'faceless-motivation',
    name: 'Motivasi sinematik',
    group: 'faceless',
    description: 'FPV drone, golden hour, siluet, flare anamorfik. Untuk quote/motivasi dan opening epik.',
    techniques: ['camera-movement/fpv-drone', 'lighting/golden-hour', 'lighting/silhouette', 'effects/anamorphic-flare'],
    style: 'epic and hopeful, sweeping scale, warm sun flares',
    negative: [...DEFAULT_NEGATIVE, 'faces'],
    aspect: '9:16',
    durationSec: 6,
    character: 'a lone hiker',
    subjectExample: 'reaches a volcanic ridge above the clouds at sunrise',
    previewKey: 'camera-movement/fpv-drone'
  },
  {
    id: 'faceless-product',
    name: 'Produk / ASMR',
    group: 'faceless',
    description: 'Product hero, turntable, backlight, fokus dangkal, slow motion. Untuk iklan produk dan konten ASMR.',
    techniques: ['framing/product', 'camera-movement/lazy-susan', 'lighting/backlight', 'effects/shallow-focus', 'time-and-motion/slow-motion'],
    style: 'premium commercial look, glossy reflections, crisp macro detail',
    negative: DEFAULT_NEGATIVE,
    aspect: '9:16',
    durationSec: 6,
    character: 'an iced palm-sugar coffee in a clear glass',
    subjectExample: 'condensation slowly drips down the glass',
    previewKey: 'camera-movement/lazy-susan'
  }
];

const TITLE_SUFFIX = /\s+(cinematography|look)$/i;

/** Every genre-look and viral-look technique becomes a one-click style preset. */
export function catalogPresets(techniques: Technique[]): StylePreset[] {
  return techniques
    .filter(t => t.c === 'genre-looks' || t.c === 'viral-looks')
    .map(t => ({
      id: `${t.c}-${t.s}`,
      name: t.n.replace(TITLE_SUFFIX, ''),
      group: t.c === 'genre-looks' ? 'genre' as const : 'viral' as const,
      description: t.d,
      techniques: [techniqueKey(t)],
      style: '',
      negative: DEFAULT_NEGATIVE,
      aspect: '9:16' as const,
      durationSec: 6 as const,
      subjectExample: '',
      previewKey: techniqueKey(t)
    }));
}

export function allPresets(techniques: Technique[]): StylePreset[] {
  return [...CURATED_PRESETS, ...catalogPresets(techniques)];
}

export function presetPreview(preset: StylePreset, techniques: Technique[]): { video?: string; image?: string } {
  const t = techniques.find(x => techniqueKey(x) === preset.previewKey);
  return { ...(t?.v ? { video: t.v } : {}), ...(t?.i ? { image: t.i } : {}) };
}

export type ComposerState = {
  picked: Technique[];
  aspect: '9:16' | '16:9';
  durationSec: number;
  subject: string;
  character: string;
  style: string;
  negative: string[];
};

export function applyPreset(preset: StylePreset, techniques: Technique[]): ComposerState {
  const byKey = new Map(techniques.map(t => [techniqueKey(t), t]));
  return {
    picked: preset.techniques
      .map(key => {
        const t = byKey.get(key);
        const override = preset.overrides?.[key];
        return t && override ? { ...t, p: override } : t;
      })
      .filter((t): t is Technique => t !== undefined),
    aspect: preset.aspect,
    durationSec: preset.durationSec,
    subject: preset.subjectExample,
    character: preset.character ?? '',
    style: preset.style,
    negative: preset.negative
  };
}

/** Full Veo/Flow shot prompt: camera → character/subject → look → Style → Negative prompt. */
export function composeShot(input: {
  subject: string;
  character: string;
  picked: Technique[];
  style: string;
  negative: string[];
}): string {
  const body = composePrompt(input.subject, input.picked, { anchor: input.character });
  const style = input.style.trim() ? `Style: ${input.style.trim().replace(/[.]+$/, '')}.` : '';
  const negative = input.negative.map(n => n.trim()).filter(Boolean);
  const head = [body, style].filter(Boolean).join(' ');
  return negative.length ? `${head}\nNegative prompt: ${negative.join(', ')}.` : head;
}

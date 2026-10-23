/** One cinematic technique (compact form of knowledge/cinematic-video/techniques.json). */
export type Technique = {
  /** category slug, e.g. "camera-movement" */
  c: string;
  /** technique slug, e.g. "dolly-in" */
  s: string;
  /** display name */
  n: string;
  /** definition */
  d: string;
  /** prompt template; "[Subject]" is replaced by the scene subject */
  p: string;
  /** sample clip (mp4) from the source catalog, when available */
  v?: string;
  /** still/thumbnail image */
  i?: string;
};

export const TECHNIQUE_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'camera-movement', label: 'Gerak kamera' },
  { key: 'framing', label: 'Framing' },
  { key: 'camera-angles', label: 'Sudut kamera' },
  { key: 'lighting', label: 'Pencahayaan' },
  { key: 'composition', label: 'Komposisi' },
  { key: 'lenses', label: 'Lensa' },
  { key: 'color', label: 'Warna & film look' },
  { key: 'time-and-motion', label: 'Waktu & gerak' },
  { key: 'effects', label: 'Efek' },
  { key: 'editing', label: 'Editing & transisi' },
  { key: 'atmosphere', label: 'Atmosfer' },
  { key: 'genre-looks', label: 'Genre look' },
  { key: 'viral-looks', label: 'Viral look' }
];

export function techniqueKey(t: Pick<Technique, 'c' | 's'>): string {
  return `${t.c}/${t.s}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** ~30% of catalog prompts are example scenes, not templates; only "[Subject]" prompts are safe to inject. */
export function isTemplate(t: Technique): boolean {
  return /\[Subject\]/i.test(t.p);
}

/** Named technique as a cinematography term, e.g. "Golden Hour Cinematography" -> "Golden hour". */
export function techniqueTerm(t: Technique): string {
  const name = t.n.replace(/\s+cinematography$/i, '').trim();
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/** Cinematography categories, in the order Veo reads them best: framing, angle, lens, then the single move. */
const CAMERA_ORDER = ['framing', 'camera-angles', 'lenses', 'camera-movement'];

/**
 * Veo/Flow formula: [Cinematography] + [Subject/Action] + [Style & Ambiance].
 * Camera techniques lead (early words weigh more), then the subject, then
 * lighting/colour/atmosphere/look. "[Subject]" is substituted everywhere.
 */
/** Short back-reference for an already-introduced subject: "a woman in her 30s, red coat" -> "the woman in her 30s". */
export function shortReference(noun: string): string {
  // Head noun phrase: cut at the first comma or attribute preposition ("with", "in", "at", "carrying" ...).
  const head = noun.trim().split(/,|\s(?:with|in|at|on|wearing|carrying|holding|from|under|near|beside)\s/i)[0]!.trim();
  const words = head.replace(/^(a|an|the)\s+/i, '').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 7) return 'the subject';
  return `the ${words.join(' ')}`;
}

function capitalise(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Veo/Flow formula: [Cinematography] + [Subject/Action] + [Style & Ambiance].
 * Camera techniques lead (early words weigh more), then the subject, then
 * lighting/colour/atmosphere/look. The subject is described in full once and
 * referred to briefly afterwards; an optional anchor (character/main subject
 * noun) keeps the description identical across shots.
 */
export function composePrompt(subject: string, techniques: Technique[], options: { anchor?: string } = {}): string {
  const action = subject.trim();
  const anchor = options.anchor?.trim() ?? '';
  const noun = anchor || action;
  const seen = new Set<string>();
  const unique = techniques.filter(t => {
    const key = techniqueKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const subjectSentence = (introduced: boolean) => {
    if (anchor && action) return `${introduced ? shortReference(anchor) : anchor} — ${action}`;
    return anchor || action;
  };
  if (unique.length === 0) return capitalise(subjectSentence(false));
  let introduced = false;
  const mention = () => {
    if (!noun) return 'the subject';
    if (introduced) return shortReference(noun);
    introduced = true;
    return noun;
  };
  const render = (t: Technique) => (isTemplate(t)
    ? sentence(t.p.replace(/\[Subject\]/gi, () => mention()))
    : sentence(techniqueTerm(t)));
  const camera = unique
    .filter(t => CAMERA_ORDER.includes(t.c))
    .sort((a, b) => CAMERA_ORDER.indexOf(a.c) - CAMERA_ORDER.indexOf(b.c))
    .map(render);
  const subjectLine = action || anchor ? sentence(subjectSentence(introduced)) : '';
  // The subject sentence always carries the action; for a subject-only prompt it is the full description.
  if (subjectLine && !introduced && noun) introduced = true;
  const look = unique.filter(t => !CAMERA_ORDER.includes(t.c)).map(render);
  return capitalise([...camera, ...(subjectLine ? [subjectLine] : []), ...look].join(' '));
}

/** Guardrails from the Veo prompting research (knowledge/cinematic-video/web/veo-flow-prompting.md). */
export function promptWarnings(techniques: Technique[]): string[] {
  const moves = new Set(techniques.filter(t => t.c === 'camera-movement').map(techniqueKey));
  return moves.size > 1
    ? ['Veo paling stabil dengan satu gerakan kamera per shot — pilih satu, sisanya jadikan shot terpisah.']
    : [];
}

export function filterTechniques(all: Technique[], category: string, query: string): Technique[] {
  const q = query.trim().toLowerCase();
  return all.filter(t =>
    (category === 'all' || t.c === category)
    && (!q || t.n.toLowerCase().includes(q) || t.d.toLowerCase().includes(q))
  );
}

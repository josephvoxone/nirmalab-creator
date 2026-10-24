/**
 * What "Naskah & suara" asks the LLM for, per kind of text. Pure so the briefs are
 * testable and the page only wires them up. The briefs are Indonesian because the
 * output must be; they ask for spoken text only so it can go straight to TTS.
 */

export type ScriptKind = 'narasi' | 'hook' | 'caption' | 'bebas';

export const SCRIPT_KINDS: Array<{ value: ScriptKind; label: string; hint: string; placeholder: string }> = [
  {
    value: 'narasi', label: 'Narasi video pendek',
    hint: 'Voice-over maks. 60 dtk: 6–10 kalimat pendek, dibuka dengan hook.',
    placeholder: 'Contoh: kenapa kucing suka masuk ke kotak kardus'
  },
  {
    value: 'hook', label: 'Hook pembuka',
    hint: '3 opsi kalimat pembuka untuk 3 detik pertama. Pilih satu.',
    placeholder: 'Contoh: tips hemat listrik di rumah kos'
  },
  {
    value: 'caption', label: 'Caption & hashtag',
    hint: 'Caption singkat untuk TikTok/Reels plus 5–8 hashtag.',
    placeholder: 'Contoh: video resep sambal matah 5 menit'
  },
  {
    value: 'bebas', label: 'Bebas',
    hint: 'Tulis perintah sendiri, dikirim apa adanya ke model.',
    placeholder: 'Contoh: tulis dialog lucu antara kopi dan teh, 6 baris'
  }
];

const SPOKEN_ONLY = 'Tulis hanya teks yang dibacakan: tanpa judul, tanpa nomor, tanpa label adegan, tanpa arahan dalam kurung, tanpa emoji, tanpa hashtag.';

const SYSTEM: Record<Exclude<ScriptKind, 'bebas'>, string> = {
  narasi: [
    'Kamu penulis naskah voice-over untuk video pendek faceless dan video cerita (TikTok, Reels, Shorts) dalam bahasa Indonesia.',
    'Tulis 6–10 kalimat pendek, total maksimal 60 detik bila dibacakan (sekitar 130 kata).',
    'Kalimat pertama adalah hook yang membuat orang berhenti scroll. Satu kalimat satu gagasan, maksimal 15 kata.',
    'Pakai bahasa lisan sehari-hari yang enak didengar, bukan bahasa baku yang kaku. Akhiri dengan penutup atau ajakan singkat.',
    'Satu kalimat per baris.',
    SPOKEN_ONLY
  ].join(' '),
  hook: [
    'Kamu penulis hook untuk video pendek (TikTok, Reels, Shorts) dalam bahasa Indonesia.',
    'Tulis tepat 3 opsi hook pembuka. Masing-masing satu kalimat, maksimal 12 kata, cukup dibacakan dalam 3 detik pertama.',
    'Pakai sudut yang berbeda: pertanyaan yang memancing, fakta atau angka yang mengejutkan, dan janji hasil yang bikin penasaran.',
    "Format: satu hook per baris, diawali '1.', '2.', '3.'. Tanpa penjelasan, tanpa emoji, tanpa hashtag."
  ].join(' '),
  caption: [
    'Kamu penulis caption media sosial untuk video pendek (TikTok, Instagram Reels, YouTube Shorts) dalam bahasa Indonesia.',
    'Tulis caption 2–3 kalimat: baris pembuka yang memancing rasa ingin tahu, isi singkat, lalu ajakan (komentar, simpan, atau ikuti).',
    'Setelah itu satu baris kosong, lalu 5–8 hashtag relevan dalam satu baris: campuran populer dan spesifik, huruf kecil, dipisah spasi.',
    'Maksimal 2 emoji. Tanpa judul dan tanpa penjelasan tambahan.'
  ].join(' ')
};

/** The body for POST /api/generate/text (minus the model). `bebas` sends the idea as-is. */
export function buildScriptRequest(kind: ScriptKind, topic: string): { prompt: string; system?: string } {
  const idea = topic.trim();
  if (kind === 'bebas') return { prompt: idea };
  return { system: SYSTEM[kind], prompt: `Topik / ide: ${idea}` };
}

/** Text a voice can read: no markdown marks, list numbers, headings or hashtags. */
export function toSpeech(text: string): string {
  return text
    .split('\n')
    .map(line => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/(\*\*|__|\*|_)(.+?)\1/g, '$2')
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
      .replace(/[ \t]+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Spoken length at ~150 words a minute (2.5 words a second), rounded up. */
export function estimateSeconds(text: string): number {
  return Math.ceil(wordCount(text) / 2.5);
}

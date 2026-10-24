/**
 * Anti-slop lint for the copy we ship to real people (spec §4.3 lint list, §7 P4).
 *
 * Three jobs, one vocabulary:
 * - `lintCopy(text, { kind })` — Indonesian findings for narration, caption, title, tagline.
 *   Every finding is one plain sentence a writer can act on, never "invalid input".
 * - `repairCopy(text, { kind })` — fixes only what a machine can fix honestly (emoji,
 *   exclamation stacks, shouting, filler prefixes, an empty adjective, an over-long line)
 *   and reports each fix. Anything that needs a rewrite is left for the lint to reject.
 * - `hookScore(text)` — 0..100: a concrete subject + a verb + one tension word beat
 *   adjectives. Used to rank taglines and to prove a caption improved.
 *
 * `lintCover` checks the frame slots of a cover prompt (subject, action, place, light
 * direction, lens) — English prompt text, Indonesian findings.
 *
 * Pure data + pure functions: no IO, no randomness.
 */

export type CopyKind = 'narration' | 'caption' | 'title' | 'tagline';

export type CopyOptions = { kind: CopyKind };

/** Narration fits a ~6 s shot when it stays this short (spec §4.3). */
export const NARRATION_MAX_WORDS = 12;
/** Instagram's caption ceiling; the same number we truncate to on publish. */
export const CAPTION_MAX_CHARS = 2200;
/** One breath on a card. */
export const TAGLINE_MAX_CHARS = 70;

/**
 * Feelings that stand in for a fact. Indonesian and English spellings of the same claim are
 * both listed: a template that says "epic" in one language and "epik" in the other is the
 * same slop.
 */
export const BANNED_WORDS: readonly string[] = [
  'indah', 'keindahan', 'megah', 'megahnya',
  'epic', 'epik',
  'memukau', 'mengagumkan', 'menakjubkan', 'memesona', 'menawan',
  'luar biasa', 'takjub', 'mengejutkan', 'menyentuh', 'mengharukan',
  'cinematic', 'sinematik', 'dramatis', 'spektakuler', 'fantastis',
  'ajaib', 'keren', 'sempurna', 'wajib nonton', 'bikin penasaran'
];

/** Openers and tics that announce a story instead of telling it. */
export const AI_TELLS: readonly string[] = ['dalam dunia yang', 'dalam dunia ini', 'tak hanya', 'bukan sekadar', 'mari kita', 'simak', 'yuk'];

/** Filler that pushes the first event one line down. */
const FILLER = ['sinopsis', 'cerita ini tentang', 'cerita ini'];

/** Words that are visible on screen: the subject test for a caption or a tagline. */
const CONCRETE_NOUNS: readonly string[] = [
  // animals
  'kucing', 'anjing', 'ayam', 'bebek', 'gurita', 'ikan', 'burung', 'pipit', 'siput', 'monyet',
  'kura-kura', 'kancil', 'sapi', 'kambing', 'kerbau', 'ular', 'tikus', 'lebah', 'kupu-kupu', 'kodok',
  // sky and weather
  'bintang', 'bulan', 'matahari', 'pelangi', 'awan', 'hujan', 'salju', 'kabut',
  // land
  'laut', 'pantai', 'pulau', 'gunung', 'hutan', 'pohon', 'daun', 'bambu', 'sungai', 'danau',
  'sawah', 'ladang', 'kebun', 'jalan', 'gang', 'jembatan', 'pasar', 'kedai', 'warung',
  // places and objects
  'dapur', 'kamar', 'rumah', 'pagar', 'pintu', 'jendela', 'laci', 'meja', 'kursi', 'lampu',
  'lilin', 'cermin', 'jam', 'pisau', 'wajan', 'panci', 'gelas', 'toples', 'koin', 'uang',
  'sepatu', 'sol', 'baju', 'kain', 'batik', 'keris', 'candi', 'batu', 'tembok', 'atap', 'tangga',
  'kapal', 'perahu', 'sepeda', 'motor', 'mobil', 'truk', 'kereta', 'stasiun', 'halte',
  'telepon', 'surat', 'buku', 'pensil', 'kertas', 'lukisan', 'foto', 'peta', 'botol',
  'keranjang', 'tas', 'topi', 'payung', 'balon', 'layang-layang', 'mainan', 'robot', 'komputer',
  // sound and stage
  'lagu', 'gamelan', 'gendang', 'wayang', 'tari',
  // food
  'tempe', 'tahu', 'nasi', 'kue', 'kopi', 'teh', 'gula', 'bawang', 'cabai', 'terasi',
  'apel', 'pisang', 'mangga', 'padi', 'biji', 'buah', 'sayur', 'daging', 'telur', 'air',
  // people (a person in frame is a concrete subject)
  'ibu', 'ayah', 'nenek', 'kakek', 'anak', 'gadis', 'pemuda', 'remaja', 'siswa', 'guru',
  'petani', 'nelayan', 'kurir', 'pendekar', 'putri', 'raja', 'pelari', 'penjaga', 'pemilik',
  'tetangga', 'sahabat', 'orang', 'perempuan', 'laki-laki', 'bayi', 'balita', 'pedagang',
  'penari', 'filsuf', 'dokter', 'polisi'
];

/** Verbs that carry a visible action (Indonesian, base and common affixed forms). */
const VERBS: readonly string[] = [
  'menunggu', 'menantang', 'tertidur', 'menolak', 'meminta', 'berlayar', 'mencari', 'menyala',
  'mencoba', 'terbang', 'punya', 'kabur', 'jatuh', 'bangun', 'diseduh', 'berteduh', 'menjual',
  'menerima', 'memasak', 'menempel', 'mengantar', 'bertemu', 'membagi', 'mendapat', 'belajar',
  'membentur', 'menemukan', 'diuji', 'dibagi', 'diulek', 'diaduk', 'menetes', 'bersahutan',
  'dipakai', 'memotong', 'menghitung', 'bertanya', 'muncul', 'mengajak', 'mengecil', 'terdengar',
  'hilang', 'dibobol', 'berhenti', 'menghadapi', 'mengabdi', 'mendaki', 'berenang',
  'menyaksikan', 'pulang', 'pergi', 'ditinggal', 'menyimpan', 'membuka', 'menutup', 'menulis',
  'membaca', 'menggoreng', 'menyapu', 'memeluk', 'menangis', 'tertawa', 'tidur', 'naik',
  'turun', 'duduk', 'berdiri', 'melompat', 'mengambil', 'memberi', 'membawa', 'melempar',
  'mengangkat', 'memetik', 'menanam', 'memancing', 'menjahit', 'menganyam', 'menabuh',
  'menggendong', 'menjemput', 'menyusul', 'mengejar', 'menunggangi', 'menggali', 'menyalakan',
  'mematikan', 'mengetuk', 'menjerit', 'berbisik', 'menyanyi', 'menari', 'berlari', 'melangkah',
  'memasang', 'merapikan', 'menghapus', 'menyeka', 'menuang', 'memotret', 'melukis', 'mengukir',
  'menampi', 'menumbuk', 'menakar', 'mengayuh', 'menembak', 'menusuk', 'menangkis', 'membungkuk',
  'berjalan', 'terasa', 'menguji', 'membeli', 'menjawab', 'dapat', 'menuntun', 'merapal', 'menyisir'
];

/** The words that make a line feel like it has stakes. */
const TENSION: readonly string[] = [
  'tapi', 'tetapi', 'namun', 'ternyata', 'hilang', 'rahasia', 'tertinggal', 'ditinggal', 'gagal',
  'menunggu', 'tidak', 'tak', 'hanya', 'belum', 'sampai', 'akhirnya', 'terakhir', 'salah',
  'ketahuan', 'berhenti', 'pecah', 'bocor', 'misteri', 'jangan', 'terpaksa', 'menolak', 'kabur',
  'tertidur', 'tersesat', 'terpisah', 'sendirian', 'gelap', 'terancam', 'bangkrut', 'utang',
  'kehilangan', 'menghadapi', 'melawan', 'terkunci', 'tertutup', 'terlambat', 'kalah', 'menyerah'
];

/** Capitals that are not shouting: units, institutions and the app's own jargon. */
const ALLOWED_CAPS = new Set([
  'ASMR', 'UMKM', 'UGC', 'SMA', 'SMP', 'SD', 'POV', 'BGM', 'HDR', 'AI', 'TV', 'ID', 'IG',
  'TTS', 'RT', 'RW', 'PT', 'CV', 'OK', 'US', 'UK', 'USA', 'I', 'II', 'III', 'IV', 'V', 'VI'
]);

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/u;
const CAPITALISED = /\b[A-Z][A-Z0-9]{1,}\b/g;

const lower = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

const escapeRe = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (word: string) => new RegExp(`(?<![\\w-])${escapeRe(word)}(?![\\w-])`, 'i');

const CONCRETE_RE = new RegExp(`(?<![\\w-])(${CONCRETE_NOUNS.map(escapeRe).join('|')})(?![\\w-])`, 'i');
const VERB_RE = new RegExp(`(?<![\\w-])(${VERBS.map(escapeRe).join('|')})(?:nya|lah|ku|mu)?(?![\\w-])`, 'i');
const TENSION_RE = new RegExp(`(?<![\\w-])(${TENSION.map(escapeRe).join('|')})(?![\\w-])`, 'i');

/** A sentence-initial capital is grammar, not a proper noun. */
const SENTENCE_START_STOP = new Set([
  'SAYA', 'AKU', 'KAMI', 'KITA', 'MEREKA', 'DIA', 'IA', 'INI', 'ITU', 'YANG', 'TAPI', 'TETAPI',
  'NAMUN', 'LALU', 'SETELAH', 'SEBELUM', 'SAAT', 'KETIKA', 'SETIAP', 'JADI', 'DAN', 'DI', 'KE',
  'DARI', 'DENGAN', 'UNTUK', 'PADA', 'DALAM', 'TANPA', 'SAMBIL', 'WAKTU', 'PAGI', 'SIANG',
  'SORE', 'MALAM', 'SUBUH', 'HUJAN', 'SEMUA', 'SEORANG', 'SEEKOR', 'SATU', 'DUA', 'TIGA'
]);

const bannedHits = (text: string): string[] => BANNED_WORDS.filter(word => wordRe(word).test(text));
const tellHits = (text: string): string[] => {
  const body = lower(text);
  const hits = AI_TELLS.filter(tell => body.includes(tell));
  // "Dalam dunia ..." opens like a trailer voice-over even without "yang".
  if (/^dalam dunia\b/.test(body) && !hits.includes('dalam dunia yang')) hits.push('dalam dunia');
  return hits;
};
const fillerHits = (text: string): string[] => {
  const body = lower(text);
  return FILLER.filter(filler => new RegExp(`^${escapeRe(filler)}\\b`).test(body) || body.includes(filler));
};
const shoutingHits = (text: string, kind: CopyKind): string[] => {
  const matches = (text.match(CAPITALISED) ?? []).filter(word => !ALLOWED_CAPS.has(word) && !/\d/.test(word));
  if (!matches.length) return [];
  // A title card is uppercase on purpose; a shouted word inside a line is not.
  const card = kind === 'title' && words(text).length <= 4 && words(text).every(word => word === word.toUpperCase());
  return card ? [] : [...new Set(matches)];
};

/** Visible subject: a concrete noun, a name mid-sentence, or a name that heads an action. */
export function hasConcreteSubject(text: string): boolean {
  if (CONCRETE_RE.test(text)) return true;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const tokens = sentence.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const clean = (token: string) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    // A name opening the sentence counts only when the sentence also has an action:
    // "Jingga menunggu di pagar." is a subject, "Kisah sedih hewan peliharaan" is a label.
    const head = clean(tokens[0]!);
    if (head.length >= 3 && /^[A-Z]/.test(head) && !SENTENCE_START_STOP.has(head.toUpperCase()) && VERB_RE.test(sentence)) {
      return true;
    }
    for (let i = 1; i < tokens.length; i++) {
      const token = clean(tokens[i]!);
      if (token.length < 3) continue;
      if (!/^[A-Z]/.test(token)) continue;
      if (token === token.toUpperCase() && SENTENCE_START_STOP.has(token)) continue;
      return true;
    }
  }
  return false;
}

export function hasVerb(text: string): boolean {
  return VERB_RE.test(text);
}

/** Indonesian findings, one per rule broken. Empty array = the copy passes. */
export function lintCopy(text: string | undefined, options: CopyOptions): string[] {
  const { kind } = options;
  const copy = (text ?? '').trim();
  const issues: string[] = [];
  if (!copy) return [`${kind} kosong — tulis satu kalimat yang bisa dilihat`];

  for (const word of bannedHits(copy)) {
    issues.push(`kata sifat kosong "${word}" tanpa bukti — ganti dengan detail yang bisa dilihat`);
  }
  for (const tell of tellHits(copy)) {
    issues.push(`frasa AI "${tell}" — langsung ke peristiwa, jangan buka dengan pembuka`);
  }
  for (const filler of fillerHits(copy)) {
    issues.push(`kata pengisi "${filler}" — potong dan mulai dari peristiwanya`);
  }
  if (/!{2,}/.test(copy)) issues.push('tanda seru beruntun — satu kalimat cukup tanpa tumpukan "!!"');
  if (EMOJI.test(copy)) issues.push('emoji dihapus — naskah dibacakan, emoji tidak terdengar');
  const shouts = shoutingHits(copy, kind);
  if (shouts.length) issues.push(`huruf besar semua "${shouts[0]}" — tulis huruf biasa, hanya nama diri yang berhuruf besar`);

  if (kind === 'narration') {
    const count = words(copy).length;
    if (count > NARRATION_MAX_WORDS) {
      issues.push(`narasi ${count} kata (maks ${NARRATION_MAX_WORDS} agar muat ~6 detik)`);
    }
  }
  if (kind === 'caption') {
    if (!hasConcreteSubject(copy)) {
      issues.push('caption tanpa subjek konkret — sebut orang, hewan, atau benda yang terlihat');
    }
    if (copy.length > CAPTION_MAX_CHARS) {
      issues.push(`caption ${copy.length} karakter (maks ${CAPTION_MAX_CHARS})`);
    }
  }
  if (kind === 'tagline') {
    if (!hasConcreteSubject(copy)) {
      issues.push('tagline tanpa subjek konkret — sebut siapa atau apa yang terlihat');
    }
    if (!hasVerb(copy)) {
      issues.push('tagline tanpa kata kerja — tulis siapa melakukan apa, bukan label genre');
    }
    if (copy.length > TAGLINE_MAX_CHARS) {
      issues.push(`tagline ${copy.length} karakter (maks ${TAGLINE_MAX_CHARS})`);
    }
  }
  return issues;
}

/** Title-case a shouted word, keeping inner hyphens: "MIMI" → "Mimi". */
const titleWord = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/**
 * Mechanically fix what can be fixed without inventing content. Everything still reported by
 * `lintCopy` afterwards needs a rewrite by the writer (the caller rejects the reply).
 */
export function repairCopy(text: string | undefined, options: CopyOptions): { text: string; fixed: string[] } {
  const { kind } = options;
  let body = (text ?? '').trim();
  const fixed: string[] = [];
  const note = (message: string) => { if (!fixed.includes(message)) fixed.push(message); };

  // A caption is line-structured: repair each line, never collapse the breaks into spaces.
  if (/\n/.test(body)) {
    const lines = body.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
      const repaired = repairCopy(line, options);
      repaired.fixed.forEach(note);
      return repaired.text;
    });
    return { text: lines.join('\n'), fixed };
  }

  if (EMOJI.test(body)) {
    body = body.replace(new RegExp(EMOJI.source, 'gu'), ' ');
    note('emoji dihapus');
  }
  if (/!{2,}/.test(body)) {
    body = body.replace(/!+/g, '.');
    note('tanda seru beruntun dirapikan');
  } else if (kind === 'narration' && /!/.test(body)) {
    body = body.replace(/!/g, '.');
    note('tanda seru diganti titik');
  }
  body = body.replace(CAPITALISED, word => {
    if (ALLOWED_CAPS.has(word) || /\d/.test(word)) return word;
    if (kind === 'title' && words(body).length <= 4 && words(body).every(w => w === w.toUpperCase())) return word;
    note('huruf besar semua diubah ke huruf biasa');
    return titleWord(word);
  });
  const filler = fillerHits(body).find(f => /^(sinopsis|cerita ini)\b/i.test(body.trim()));
  if (filler) {
    body = body.replace(new RegExp(`^\\s*${escapeRe(filler)}\\s*:?\\s*`, 'i'), '');
    note('kata pengisi dihapus');
  }
  for (const word of bannedHits(body)) {
    const re = new RegExp(`(?:\\byang\\s+)?${escapeRe(word)}\\b\\s*`, 'gi');
    if (!re.test(body)) continue;
    body = body.replace(re, '');
    note(`kata sifat kosong "${word}" dihapus`);
  }
  body = body.replace(/\s+([,.;:])/g, '$1').replace(/,\s*([.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  body = body.replace(/\.{2,}/g, '.').replace(/^[,;:\s]+/, '').trim();
  if (kind === 'narration' && words(body).length > NARRATION_MAX_WORDS) {
    const kept = words(body).slice(0, NARRATION_MAX_WORDS).join(' ');
    body = `${kept.replace(/[,;:]+$/, '')}.`;
    note(`dipotong ke ${NARRATION_MAX_WORDS} kata`);
  }
  // A title and a tagline are display lines: never add punctuation they did not ask for.
  if (body && !/[.!?]$/.test(body) && (kind === 'narration' || kind === 'caption')) body = `${body}.`;
  return { text: body, fixed };
}

/**
 * 0..100. A concrete subject (+30), a verb (+25) and a tension word (+25) on top of a base of
 * 20; each banned word costs 20, each AI tell 15, shouting/emoji/exclamation stacks 10.
 */
export function hookScore(text: string | undefined): number {
  const copy = (text ?? '').trim();
  if (!copy || !words(copy).length) return 0;
  let score = 20;
  if (hasConcreteSubject(copy)) score += 30;
  if (hasVerb(copy)) score += 25;
  if (TENSION_RE.test(copy)) score += 25;
  score -= 20 * bannedHits(copy).length;
  score -= 15 * tellHits(copy).length;
  if (EMOJI.test(copy) || /!{2,}/.test(copy)) score -= 10;
  if (shoutingHits(copy, 'caption').length) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// cover prompts (English frame text, Indonesian findings)
// ---------------------------------------------------------------------------

const COVER_VERBS: readonly string[] = [
  'sit', 'stand', 'walk', 'run', 'hold', 'lift', 'pour', 'row', 'kneel', 'slice',
  'brush', 'drop', 'roll', 'look', 'circle', 'spread', 'lean', 'crawl', 'climb',
  'carry', 'wait', 'watch', 'tie', 'stack', 'steer', 'argue', 'drift', 'rain',
  'leave', 'rise', 'anchor', 'burn', 'glow', 'reach', 'open', 'throw', 'dig',
  'read', 'write', 'cook', 'sweep', 'dance', 'sing', 'sleep', 'wake', 'fall',
  'catch', 'pull', 'push', 'follow', 'chase', 'ride', 'sail', 'drive', 'paint',
  'stare', 'share', 'strain', 'cheer', 'hang', 'flap', 'wade', 'float', 'crouch', 'leap'
];
const COVER_VERB_RE = new RegExp(`(?<![\\w-])(${COVER_VERBS.join('|')})(?:s|es|ed|ing)?(?![\\w-])`, 'i');
const PLACE_PREP = /\b(in|on|at|into|inside|outside|beside|under|above|behind|before|along|across|between|near|around|over|below|beneath)\b\s+\w+/i;
const LENS = /\b(\d{2,3}\s?mm|wide-angle|macro|anamorphic|telephoto)\b/i;
const LIGHT_WORD = /\b(light|sunlight|lamplight|moonlight|firelight|daylight|sunbeams?|beams?|backlight|glow|lamp|sun|torch|torchlight|candle|neon|flashlight|headlights?|windowlight)\b/i;
const LIGHT_DIRECTION = /\b(from|behind|through|above|below|off|across|side|left|right|under|overhead|top|backlit|side-lit|top-lit|underlit|rim-lit)\b/i;
const SUBJECT_START = /^(a|an|the|[A-Z][a-z]+)\s+/i;

/** Frame slots for a cover still: subject, action, place, light direction, lens. */
export function lintCover(text: string | undefined): string[] {
  const cover = (text ?? '').trim();
  const issues: string[] = [];
  if (!cover) return ['cover kosong — tulis satu frame yang bisa difoto'];
  for (const word of bannedHits(cover)) {
    issues.push(`kata sifat kosong "${word}" tanpa bukti — sebut subjek, aksi dan cahayanya`);
  }
  for (const tell of tellHits(cover)) issues.push(`frasa AI "${tell}" — tulis frame-nya langsung`);
  if (!SUBJECT_START.test(cover)) issues.push('cover tanpa subjek konkret — mulai dengan "A/An/The <benda atau orang>"');
  if (!COVER_VERB_RE.test(cover)) issues.push('cover tanpa aksi — satu kata kerja yang terlihat di frame');
  if (!PLACE_PREP.test(cover)) issues.push('cover tanpa tempat — sebut di mana frame ini terjadi');
  if (!LIGHT_WORD.test(cover) || !LIGHT_DIRECTION.test(cover)) issues.push('cover tanpa arah cahaya — sebut dari mana cahayanya datang');
  if (!LENS.test(cover)) issues.push('cover tanpa lensa — sebut satu lensa (35mm, 85mm, macro)');
  return issues;
}

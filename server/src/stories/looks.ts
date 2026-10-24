/**
 * Studio "look" catalog (Higgsfield Cinema Studio-style pickers, mapped to what Veo/Omni
 * actually responds to). Pure data + prompt composition; the web app renders it from
 * GET /api/stories/catalog. Every option is plain English prompt text so Flow sees words,
 * not ids. Camera moves follow the Veo rules (one move per shot, never name camera gear).
 */

export type Option = { id: string; label: string; hint?: string; prompt: string };
export type Palette = Option & { swatches: string[] };
export type Tempo = Option & { shots: number };
export type Look = {
  style: string; genre: string; era: string; camera: string; lens: string;
  aperture: string; palette: string; lighting: string; tempo: string;
};
export type Template = {
  id: string; name: string; tagline: string; mode: 'konsisten' | 'cepat';
  aspect: '9:16' | '16:9'; narrator: string; example: string; look: Look;
};

const AUTO: Option = { id: 'auto', label: 'Auto', prompt: '' };

const styles: Option[] = [
  { id: 'storybook', label: 'Storybook cat air', hint: 'Ilustrasi buku cerita yang hidup', prompt: 'hand-painted storybook illustration come alive, soft watercolor textures, gentle paper grain' },
  { id: 'pixar-3d', label: 'Animasi 3D', hint: 'Film animasi 3D layar lebar', prompt: 'high-quality 3D animated feature film look, expressive stylized characters, soft subsurface skin, detailed textures' },
  { id: 'anime-2d', label: 'Anime 2D', hint: 'Garis tangan, latar dilukis', prompt: 'hand-drawn 2D anime feature film look, painted backgrounds, clean line art, soft cel shading' },
  { id: 'claymation', label: 'Claymation', hint: 'Stop-motion plastisin', prompt: 'stop-motion claymation, handmade plasticine characters with visible fingerprints, miniature handcrafted sets' },
  { id: 'papercut', label: 'Papercut', hint: 'Diorama kertas berlapis', prompt: 'layered papercut diorama animation, cut paper textures, soft drop shadows between layers' },
  { id: 'live-action', label: 'Live action', hint: 'Sinema realistis', prompt: 'photorealistic live-action cinema, natural skin texture, real locations' },
  { id: 'documentary', label: 'Dokumenter', hint: 'Footage dokumenter nyata', prompt: 'photorealistic documentary footage, natural light, observational framing' },
  { id: 'wayang', label: 'Wayang & batik', hint: 'Ilustrasi Nusantara', prompt: 'Indonesian wayang and batik inspired painted illustration, ornate patterns, warm earthy textures' },
  { id: 'comic', label: 'Komik', hint: 'Novel grafis tinta tebal', prompt: 'graphic novel illustration come alive, bold ink lines, halftone shading' },
  { id: 'lowpoly', label: 'Low poly', hint: '3D geometris lembut', prompt: 'soft low-poly 3D diorama, faceted geometry, gentle pastel lighting' }
];

const genres: Option[] = [
  { ...AUTO, label: 'Umum' },
  { id: 'drama', label: 'Drama', prompt: 'intimate emotional drama, lingering moments, expressive faces' },
  { id: 'aksi', label: 'Aksi', prompt: 'kinetic action film energy, dynamic poses and motion' },
  { id: 'epik', label: 'Epik', prompt: 'epic grand scale, sweeping vistas, heroic framing' },
  { id: 'komedi', label: 'Komedi', prompt: 'light-hearted comedy, playful timing, bright expressive characters' },
  { id: 'horor', label: 'Horor', prompt: 'eerie suspense mood, deep shadows, unsettling stillness' },
  { id: 'noir', label: 'Noir', prompt: 'film noir mood, hard shadows, mystery' },
  { id: 'dongeng', label: 'Dongeng', prompt: 'fairytale wonder, magical gentle atmosphere' },
  { id: 'petualangan', label: 'Petualangan', prompt: 'adventure spirit, discovery, wide open journeys' },
  { id: 'romansa', label: 'Romansa', prompt: 'tender romance, soft intimate warmth' },
  { id: 'dokumenter', label: 'Dokumenter', prompt: 'documentary realism, informative clarity' }
];

const eras: Option[] = [
  AUTO,
  { id: '1960s', label: '1960-an', prompt: '1960s period setting' },
  { id: '1980s', label: '1980-an', prompt: '1980s period setting' },
  { id: '1990s', label: '1990-an', prompt: '1990s period setting' },
  { id: '2000s', label: '2000-an', prompt: 'early 2000s period setting' },
  { id: '2020s', label: 'Masa kini', prompt: 'present-day setting' },
  { id: 'kerajaan', label: 'Kerajaan kuno', prompt: 'ancient Javanese kingdom era' }
];

const tempos: Tempo[] = [
  { id: 'tenang', label: 'Tenang', hint: '6 shot, napas panjang', prompt: '', shots: 6 },
  { id: 'mengalir', label: 'Mengalir', hint: '8 shot', prompt: '', shots: 8 },
  { id: 'dinamis', label: 'Dinamis', hint: '10 shot, potongan cepat', prompt: '', shots: 10 },
  { id: 'montase', label: 'Montase', hint: '12 shot', prompt: '', shots: 12 }
];

const cameras: Option[] = [
  AUTO,
  { id: 'film35', label: '35mm Film', prompt: 'shot on 35mm film, fine organic grain' },
  { id: 'film8', label: '8mm Film', prompt: '8mm home-movie film, heavy grain, gentle light leaks' },
  { id: 'dv', label: 'DV Camcorder', prompt: 'early-2000s DV camcorder look, slight video noise' },
  { id: 'modern', label: 'Digital modern', prompt: 'clean modern digital cinema look' },
  { id: 'large-format', label: 'Large format', prompt: 'large-format cinema clarity, rich detail' }
];

const lenses: Option[] = [
  AUTO,
  { id: 'vintage-anamorphic', label: 'Vintage anamorphic', prompt: 'vintage anamorphic lens look, oval bokeh, soft horizontal flares' },
  { id: 'warm-vintage', label: 'Warm vintage', prompt: 'warm vintage lens look, gentle softness' },
  { id: 'halation', label: 'Halation vintage', prompt: 'soft halation glow around highlights' },
  { id: 'clean', label: 'Clean sharp', prompt: 'clean sharp modern lens look' },
  { id: 'anamorphic', label: 'Anamorphic', prompt: 'anamorphic widescreen look, horizontal flares' }
];

const apertures: Option[] = [
  AUTO,
  { id: 'f14', label: 'f/1.4 terbuka', prompt: 'very shallow depth of field, creamy bokeh' },
  { id: 'f4', label: 'f/4 sedang', prompt: 'moderate depth of field' },
  { id: 'f11', label: 'f/11 deep focus', prompt: 'deep focus, everything sharp' }
];

const palettes: Palette[] = [
  { ...AUTO, swatches: [] },
  { id: 'pagi-keemasan', label: 'Pagi Keemasan', prompt: 'warm amber highlights, cream midtones, sage green accents', swatches: ['#f6c66b', '#e89b3c', '#fbe7c6', '#a9b77e', '#6b7f4a', '#3d3226'] },
  { id: 'senja-dongeng', label: 'Senja Dongeng', prompt: 'dusky violet shadows, rose and tangerine sky', swatches: ['#2e2a4f', '#6b4f8c', '#d9779b', '#f2a65a', '#f7d488', '#1b1b2f'] },
  { id: 'hujan-biru', label: 'Hujan Biru', prompt: 'cold muted teal blues, wet reflections', swatches: ['#0f2733', '#1f4e5f', '#3f7f8c', '#9cc3c9', '#d7e7ea', '#5a6b70'] },
  { id: 'neon-malam', label: 'Neon Tengah Malam', prompt: 'magenta and cyan neon against inky blacks', swatches: ['#0b0b1a', '#ff2e88', '#00e0ff', '#7a2cff', '#ffd23f', '#1c1c3c'] },
  { id: 'hutan-zamrud', label: 'Hutan Zamrud', prompt: 'deep emerald greens, mossy midtones, sunlit gold', swatches: ['#0e2a1f', '#1f5a3d', '#3f8f5a', '#9cc58b', '#e6d9a8', '#5a4a2e'] },
  { id: 'pastel-kapas', label: 'Pastel Kapas', prompt: 'soft pastel pinks, mint and baby blue, airy and light', swatches: ['#fde2e4', '#fad2e1', '#e2ece9', '#bee1e6', '#f0efeb', '#dfe7fd'] },
  { id: 'sepia-kenangan', label: 'Sepia Kenangan', prompt: 'faded sepia, warm nostalgic browns', swatches: ['#3b2a1a', '#6e4f2f', '#a67c52', '#d9b98c', '#f2e3c6', '#8a6e4b'] },
  { id: 'noir', label: 'Noir Monokrom', prompt: 'black and white, high contrast', swatches: ['#000000', '#1a1a1a', '#4d4d4d', '#8c8c8c', '#cfcfcf', '#ffffff'] },
  { id: 'teal-oranye', label: 'Teal & Oranye', prompt: 'teal shadows and warm orange skin tones, blockbuster grade', swatches: ['#0b3c49', '#1d6f7a', '#59a5a8', '#f2a65a', '#e0712c', '#2b1d14'] },
  { id: 'kabut-industri', label: 'Kabut Industri', prompt: 'desaturated grey-green fog', swatches: ['#2b2f2e', '#4a524f', '#6f7a74', '#9aa39c', '#c4c9c2', '#8a6f4e'] },
  { id: 'aksen-merah', label: 'Aksen Merah', prompt: 'muted desaturated world with a single crimson accent', swatches: ['#1e1e24', '#4a4e57', '#8d939c', '#d3d6da', '#b3121e', '#f4f4f4'] },
  { id: 'batik-tanah', label: 'Batik Tanah', prompt: 'earthy browns, ochre, indigo and deep red', swatches: ['#3a2314', '#7a4a24', '#c08a3e', '#e8cf9a', '#2c3e66', '#8c2f1c'] },
  { id: 'riviera', label: 'Riviera Musim Panas', prompt: 'sunny yellows, Mediterranean blues, terracotta', swatches: ['#fbd46d', '#f39c6b', '#4fb0c6', '#1d6fa3', '#f6efe0', '#6aa56b'] },
  { id: 'ungu-mistis', label: 'Ungu Mistis', prompt: 'mystic violets with a teal glow', swatches: ['#1a1033', '#3d1f66', '#7240a6', '#b07cd9', '#e8d3f5', '#2fd1c6'] },
  { id: 'musim-dingin', label: 'Musim Dingin', prompt: 'pale icy blues and soft whites', swatches: ['#e9f1f7', '#c8d9e6', '#8fa9bf', '#50708f', '#26384d', '#f7f3ec'] },
  { id: 'kodak-70', label: 'Kodak 70-an', prompt: 'faded 1970s film stock, warm mustard and olive', swatches: ['#d9a441', '#b5562d', '#6f7d3a', '#3a5a6b', '#e9d8b4', '#4a3424'] },
  { id: 'malam-hangat', label: 'Malam Hangat', prompt: 'dark night lit by warm orange lamps', swatches: ['#140d0a', '#3d1f12', '#8c3f1d', '#e07b39', '#f5c16c', '#26323a'] },
  { id: 'hijau-sawah', label: 'Hijau Sawah', prompt: 'fresh rice-field greens and bright sky blue', swatches: ['#f2e8b6', '#c9d66b', '#7fb24a', '#3f8a3a', '#2f5d50', '#87bfd6'] }
];

const lighting: Option[] = [
  AUTO,
  { id: 'golden-hour', label: 'Golden hour', prompt: 'warm golden hour sunlight' },
  { id: 'blue-hour', label: 'Blue hour', prompt: 'blue hour twilight' },
  { id: 'soft-window', label: 'Cahaya jendela', prompt: 'soft window light' },
  { id: 'practicals', label: 'Lampu praktis', prompt: 'motivated practical lamps in frame' },
  { id: 'silhouette', label: 'Siluet', prompt: 'silhouettes against a bright background' },
  { id: 'contre-jour', label: 'Contre jour', prompt: 'backlit contre-jour with glowing rim light' },
  { id: 'overhead', label: 'Overhead', prompt: 'single hard overhead light' },
  { id: 'soft-cross', label: 'Soft cross', prompt: 'soft cross lighting' },
  { id: 'moonlight', label: 'Cahaya bulan', prompt: 'cool blue moonlight' },
  { id: 'candle', label: 'Lilin', prompt: 'flickering warm candlelight' },
  { id: 'overcast', label: 'Mendung lembut', prompt: 'soft overcast daylight' },
  { id: 'neon', label: 'Neon', prompt: 'colored neon light spill' }
];

/** First half of a shot's setup sentence. */
const framings: Option[] = [
  { id: 'extreme-wide', label: 'Extreme wide', prompt: 'Extreme wide shot' },
  { id: 'wide', label: 'Wide', prompt: 'Wide shot' },
  { id: 'full', label: 'Full', prompt: 'Full shot' },
  { id: 'medium', label: 'Medium', prompt: 'Medium shot' },
  { id: 'medium-close', label: 'Medium close-up', prompt: 'Medium close-up' },
  { id: 'close-up', label: 'Close-up', prompt: 'Close-up' },
  { id: 'extreme-close', label: 'Extreme close-up', prompt: 'Extreme close-up' },
  { id: 'over-shoulder', label: 'Over the shoulder', prompt: 'Over-the-shoulder shot' },
  { id: 'low-angle', label: 'Low angle', prompt: 'Low-angle shot' },
  { id: 'high-angle', label: 'High angle', prompt: 'High-angle shot' },
  { id: 'overhead', label: 'Top down', prompt: 'Top-down overhead view' },
  { id: 'dutch', label: 'Dutch angle', prompt: 'Canted dutch angle shot' }
];

/** Second half: exactly one Veo-safe move (never names a crane, drone or rig). */
const moves: Option[] = [
  { id: 'static', label: 'Static', prompt: 'the camera stays still' },
  { id: 'push-in', label: 'Push in', prompt: 'the camera pushes in slowly' },
  { id: 'pull-back', label: 'Pull back', prompt: 'the camera pulls back slowly' },
  { id: 'pan-left', label: 'Pan kiri', prompt: 'the camera pans slowly to the left' },
  { id: 'pan-right', label: 'Pan kanan', prompt: 'the camera pans slowly to the right' },
  { id: 'tilt-up', label: 'Tilt up', prompt: 'the camera tilts up slowly' },
  { id: 'tilt-down', label: 'Tilt down', prompt: 'the camera tilts down slowly' },
  { id: 'tracking', label: 'Tracking', prompt: 'the camera tracks alongside the subject' },
  { id: 'follow', label: 'Follow', prompt: 'the camera follows behind the subject' },
  { id: 'truck-left', label: 'Truck kiri', prompt: 'the camera tracks sideways to the left' },
  { id: 'truck-right', label: 'Truck kanan', prompt: 'the camera tracks sideways to the right' },
  { id: 'arc-left', label: 'Arc kiri', prompt: 'the camera arcs slowly around the subject to the left' },
  { id: 'arc-right', label: 'Arc kanan', prompt: 'the camera arcs slowly around the subject to the right' },
  { id: 'orbit', label: 'Orbit 360', prompt: 'the camera orbits slowly all the way around the subject' },
  { id: 'rise', label: 'Naik', prompt: 'the camera rises slowly' },
  { id: 'lower', label: 'Turun', prompt: 'the camera lowers slowly to eye level' },
  { id: 'zoom-in', label: 'Slow zoom in', prompt: 'the camera slowly zooms in' },
  { id: 'zoom-out', label: 'Slow zoom out', prompt: 'the camera slowly zooms out' },
  { id: 'crash-zoom', label: 'Crash zoom', prompt: 'the camera zooms in fast on the subject' },
  { id: 'dolly-zoom', label: 'Dolly zoom', prompt: 'the camera pushes in while the background stretches away, a vertigo effect' },
  { id: 'whip-pan', label: 'Whip pan', prompt: 'the camera whip-pans quickly to the side' },
  { id: 'handheld', label: 'Handheld', prompt: 'the camera is handheld and sways gently with the action' },
  { id: 'rack-focus', label: 'Rack focus', prompt: 'the camera holds while focus shifts from the foreground to the subject' },
  { id: 'pov', label: 'POV', prompt: "the camera sees through the character's eyes" },
  { id: 'aerial-reveal', label: 'Aerial reveal', prompt: 'the camera pulls back high above to reveal the whole landscape' }
];

const look = (l: Partial<Look>): Look => ({
  style: 'storybook', genre: 'auto', era: 'auto', camera: 'auto', lens: 'auto', aperture: 'auto', palette: 'auto', lighting: 'auto', tempo: 'mengalir', ...l
});

const NARRATOR = {
  hangat: 'a warm, gentle Indonesian female storyteller',
  anak: 'a cheerful, soft Indonesian children\'s storyteller',
  dokumenter: 'a calm, deep Indonesian male documentary narrator',
  motivasi: 'an energetic, confident Indonesian male speaker',
  misteri: 'a hushed, low Indonesian male storyteller'
};

const templates: Template[] = [
  { id: 'drama-hewan', name: 'Drama Hewan', tagline: 'Kisah sedih hewan peliharaan yang menyentuh', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'storybook', genre: 'drama', palette: 'aksen-merah', lighting: 'golden-hour', lens: 'halation', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Seekor kucing oranye bernama Jingga ditinggal pemiliknya pindah rumah. Ia menunggu di depan pagar setiap sore sampai suatu hari pemiliknya kembali menjemput.' },
  { id: 'dongeng-anak', name: 'Dongeng Tidur', tagline: 'Cerita lembut pengantar tidur anak', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'storybook', genre: 'dongeng', palette: 'pastel-kapas', lighting: 'soft-window', aperture: 'f14', tempo: 'tenang' }),
    example: 'Bintang kecil bernama Kerlip takut gelap. Bulan mengajaknya berkeliling langit malam sampai Kerlip sadar bahwa cahayanya justru membuat malam indah.' },
  { id: 'fabel-3d', name: 'Fabel 3D', tagline: 'Animasi 3D lucu dengan pesan moral', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'pixar-3d', genre: 'komedi', palette: 'riviera', lighting: 'golden-hour', lens: 'clean', aperture: 'f4', tempo: 'mengalir' }),
    example: 'Kancil yang sombong menantang siput balapan menyeberangi sungai. Karena terlalu percaya diri ia tertidur, dan siput yang sabar sampai lebih dulu.' },
  { id: 'legenda-nusantara', name: 'Legenda Nusantara', tagline: 'Cerita rakyat dengan nuansa wayang & batik', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'wayang', genre: 'epik', era: 'kerajaan', palette: 'batik-tanah', lighting: 'contre-jour', tempo: 'mengalir' }),
    example: 'Seorang putri dari kerajaan di lereng gunung menolak dinikahkan dengan raja yang kejam, lalu meminta dibuatkan seribu candi dalam satu malam sebagai syarat.' },
  { id: 'anime-petualangan', name: 'Petualangan Anime', tagline: 'Perjalanan epik bergaya anime 2D', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'anime-2d', genre: 'petualangan', palette: 'hutan-zamrud', lighting: 'golden-hour', tempo: 'dinamis' }),
    example: 'Anak penjaga mercusuar menemukan peta tua di dalam botol dan berlayar dengan perahu kecil bersama anjingnya untuk mencari pulau yang hilang di balik kabut.' },
  { id: 'misteri-malam', name: 'Misteri Malam', tagline: 'Cerita seram ringan yang bikin penasaran', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'live-action', genre: 'horor', palette: 'hujan-biru', lighting: 'moonlight', camera: 'film35', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Setiap malam jam dua belas, lampu di rumah kosong ujung gang menyala sendiri. Seorang remaja memberanikan diri mengintip dan menemukan rahasia yang mengharukan.' },
  { id: 'claymation-lucu', name: 'Claymation Lucu', tagline: 'Sketsa komedi stop-motion', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'claymation', genre: 'komedi', palette: 'pastel-kapas', lighting: 'soft-cross', aperture: 'f4', tempo: 'dinamis' }),
    example: 'Seekor ayam yang ingin terbang mencoba segala cara: payung, balon, sampai ketapel. Semua gagal, sampai seekor burung pipit mengajaknya naik ke punggungnya.' },
  { id: 'fakta-faceless', name: 'Fakta Unik', tagline: 'Faceless edukasi, tanpa tokoh tetap', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.dokumenter,
    look: look({ style: 'documentary', genre: 'dokumenter', palette: 'teal-oranye', lighting: 'overcast', camera: 'modern', lens: 'clean', tempo: 'dinamis' }),
    example: 'Lima fakta mengejutkan tentang gurita: punya tiga jantung, darah biru, bisa berubah warna dalam sekejap, sangat cerdas, dan mampu kabur lewat celah sekecil koin.' },
  { id: 'motivasi', name: 'Motivasi Pagi', tagline: 'Video motivasi sinematik', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.motivasi,
    look: look({ style: 'live-action', genre: 'drama', palette: 'pagi-keemasan', lighting: 'golden-hour', camera: 'film35', lens: 'vintage-anamorphic', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Kegagalan bukan akhir. Seorang pelari yang jatuh di lintasan bangkit lagi setiap pagi sebelum matahari terbit, sampai akhirnya ia melewati garis finis.' },
  { id: 'promo-produk', name: 'Promo Produk', tagline: 'Iklan pendek produk lokal', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.motivasi,
    look: look({ style: 'live-action', genre: 'auto', palette: 'riviera', lighting: 'soft-window', camera: 'modern', lens: 'clean', aperture: 'f14', tempo: 'tenang' }),
    example: 'Kopi susu gula aren dari kedai kecil di Yogyakarta: biji kopi disangrai, susu dituang perlahan, lalu dinikmati di beranda saat hujan sore.' },
  { id: 'romansa-kota', name: 'Romansa Kota', tagline: 'Cerita cinta hangat di kota hujan', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'anime-2d', genre: 'romansa', palette: 'malam-hangat', lighting: 'practicals', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Dua orang asing selalu berteduh di halte yang sama setiap hujan. Mereka tidak pernah bicara, sampai suatu sore salah satunya membawa dua payung.' }
];

export const CATALOG = { templates, styles, genres, eras, tempos, cameras, lenses, apertures, palettes, lighting, framings, moves };
export type Catalog = typeof CATALOG;

const pick = <T extends Option>(list: T[], id: string | undefined, fallback = 'auto') =>
  list.find(o => o.id === id) ?? list.find(o => o.id === fallback) ?? list[0]!;

/** Template defaults ← explicit picks; unknown ids become auto (style: storybook). */
export function resolveLook(input: { template?: string; look?: Partial<Record<keyof Look, unknown>> }): Look {
  const base = templates.find(t => t.id === input.template)?.look ?? look({});
  const want = (key: keyof Look) => (typeof input.look?.[key] === 'string' ? (input.look[key] as string) : base[key]);
  return {
    style: pick(styles, want('style'), 'storybook').id,
    genre: pick(genres, want('genre')).id,
    era: pick(eras, want('era')).id,
    camera: pick(cameras, want('camera')).id,
    lens: pick(lenses, want('lens')).id,
    aperture: pick(apertures, want('aperture')).id,
    palette: pick(palettes, want('palette')).id,
    lighting: pick(lighting, want('lighting')).id,
    tempo: pick(tempos, want('tempo'), 'mengalir').id
  };
}

/** One "Style:" line every shot, keyframe and character sheet shares — the visual half of consistency. */
export function composeStyle(l: Look): string {
  const p = <T extends Option>(list: T[], id: string) => pick(list, id).prompt;
  const head = [p(styles, l.style), p(genres, l.genre), p(eras, l.era)].filter(Boolean).join(', ');
  const optics = [p(cameras, l.camera), p(lenses, l.lens), p(apertures, l.aperture)].filter(Boolean).join(', ');
  const grade = p(palettes, l.palette);
  const light = p(lighting, l.lighting);
  return [
    `Style: ${head}, cinematic composition.`,
    optics ? `${optics.charAt(0).toUpperCase()}${optics.slice(1)}.` : '',
    grade ? `Color grade: ${grade}.` : '',
    light ? `Lighting: ${light}.` : ''
  ].filter(Boolean).join(' ');
}

export function shotCountFor(l: Look): number {
  return pick(tempos, l.tempo, 'mengalir').shots;
}

/** Replace a shot's first "<framing>, the camera …." sentence (or prepend one). */
export function setShotSetup(prompt: string, framingId: string, moveId: string): string {
  const framing = pick(framings, framingId, 'medium').prompt;
  const move = pick(moves, moveId, 'static').prompt;
  const setup = `${framing}, ${move}.`;
  const rest = prompt.replace(/^\s*[^.]*\bthe camera\b[^.]*\.\s*/i, '').trim();
  return rest ? `${setup} ${rest}` : setup;
}

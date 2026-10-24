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
export type TemplateCategory = 'drama' | 'anak' | 'faceless' | 'promo' | 'edukasi' | 'horor' | 'budaya';
export type Template = {
  id: string; name: string; tagline: string; category: TemplateCategory; mode: 'konsisten' | 'cepat';
  aspect: '9:16' | '16:9'; narrator: string; example: string; look: Look;
  /** Scene for the template's cover still (generated through the app queue). */
  cover: string;
};

const AUTO: Option = { id: 'auto', label: 'Auto', prompt: '' };

/** Template shelves in the web picker (Indonesian labels, in display order). */
export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string; hint: string }[] = [
  { id: 'drama', label: 'Drama', hint: 'Kisah haru, romansa, komedi dan fiksi bertokoh tetap' },
  { id: 'anak', label: 'Anak', hint: 'Dongeng, fabel dan lagu yang aman untuk anak' },
  { id: 'faceless', label: 'Faceless', hint: 'Narasi di atas b-roll, tanpa tokoh tetap' },
  { id: 'promo', label: 'Promo', hint: 'Iklan produk, ulasan dan kisah usaha lokal' },
  { id: 'edukasi', label: 'Edukasi', hint: 'Belajar angka, sains dan sejarah singkat' },
  { id: 'horor', label: 'Horor & misteri', hint: 'Seram ringan dan misteri tanpa adegan sadis' },
  { id: 'budaya', label: 'Budaya', hint: 'Legenda, silat dan wisata Nusantara' }
];

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
  misteri: 'a hushed, low Indonesian male storyteller',
  ceria: 'a friendly, upbeat Indonesian female presenter',
  jenaka: 'a playful, witty Indonesian male storyteller',
  lagu: 'a bright, sing-song Indonesian children\'s singer',
  bijak: 'a calm, measured, deep Indonesian male voice',
  bisik: 'a soft, slow, near-whispering Indonesian female voice',
  epik: 'a deep, resonant Indonesian male storyteller'
};

const templates: Template[] = [
  { id: 'drama-hewan', category: 'drama', cover: 'An orange cat sits alone in front of a wooden gate at dusk, waiting, a moving truck driving away down the village road.', name: 'Drama Hewan', tagline: 'Kisah sedih hewan peliharaan yang menyentuh', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'storybook', genre: 'drama', palette: 'aksen-merah', lighting: 'golden-hour', lens: 'halation', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Seekor kucing oranye bernama Jingga ditinggal pemiliknya pindah rumah. Ia menunggu di depan pagar setiap sore sampai suatu hari pemiliknya kembali menjemput.' },
  { id: 'dongeng-anak', category: 'anak', cover: 'A tiny shy star with a soft sleepy face floats beside a gentle smiling crescent moon above quiet sleeping rooftops.', name: 'Dongeng Tidur', tagline: 'Cerita lembut pengantar tidur anak', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'storybook', genre: 'dongeng', palette: 'pastel-kapas', lighting: 'soft-window', aperture: 'f14', tempo: 'tenang' }),
    example: 'Bintang kecil bernama Kerlip takut gelap. Bulan mengajaknya berkeliling langit malam sampai Kerlip sadar bahwa cahayanya justru membuat malam indah.' },
  { id: 'fabel-3d', category: 'anak', cover: 'A smug mouse-deer and a determined little snail at the start line of a race beside a river, forest animals cheering.', name: 'Fabel 3D', tagline: 'Animasi 3D lucu dengan pesan moral', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'pixar-3d', genre: 'komedi', palette: 'riviera', lighting: 'golden-hour', lens: 'clean', aperture: 'f4', tempo: 'mengalir' }),
    example: 'Kancil yang sombong menantang siput balapan menyeberangi sungai. Karena terlalu percaya diri ia tertidur, dan siput yang sabar sampai lebih dulu.' },
  { id: 'legenda-nusantara', category: 'budaya', cover: 'A princess in Javanese royal attire stands before rows of unfinished stone temples on a moonlit night, torches burning.', name: 'Legenda Nusantara', tagline: 'Cerita rakyat dengan nuansa wayang & batik', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'wayang', genre: 'epik', era: 'kerajaan', palette: 'batik-tanah', lighting: 'contre-jour', tempo: 'mengalir' }),
    example: 'Seorang putri dari kerajaan di lereng gunung menolak dinikahkan dengan raja yang kejam, lalu meminta dibuatkan seribu candi dalam satu malam sebagai syarat.' },
  { id: 'anime-petualangan', category: 'drama', cover: 'A boy and his small dog sail a little wooden boat across a misty sea, an old lighthouse glowing behind them.', name: 'Petualangan Anime', tagline: 'Perjalanan epik bergaya anime 2D', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'anime-2d', genre: 'petualangan', palette: 'hutan-zamrud', lighting: 'golden-hour', tempo: 'dinamis' }),
    example: 'Anak penjaga mercusuar menemukan peta tua di dalam botol dan berlayar dengan perahu kecil bersama anjingnya untuk mencari pulau yang hilang di balik kabut.' },
  { id: 'misteri-malam', category: 'horor', cover: 'A teenager peeks through the window of an abandoned house at midnight, a single warm lamp glowing inside, light rain.', name: 'Misteri Malam', tagline: 'Cerita seram ringan yang bikin penasaran', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'live-action', genre: 'horor', palette: 'hujan-biru', lighting: 'moonlight', camera: 'film35', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Setiap malam jam dua belas, lampu di rumah kosong ujung gang menyala sendiri. Seorang remaja memberanikan diri mengintip dan menemukan rahasia yang mengharukan.' },
  { id: 'claymation-lucu', category: 'anak', cover: 'A chicken wearing a tiny helmet, tied to colorful balloons, tries to take off from a farmyard fence.', name: 'Claymation Lucu', tagline: 'Sketsa komedi stop-motion', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'claymation', genre: 'komedi', palette: 'pastel-kapas', lighting: 'soft-cross', aperture: 'f4', tempo: 'dinamis' }),
    example: 'Seekor ayam yang ingin terbang mencoba segala cara: payung, balon, sampai ketapel. Semua gagal, sampai seekor burung pipit mengajaknya naik ke punggungnya.' },
  { id: 'fakta-faceless', category: 'faceless', cover: 'Close macro view of an octopus changing colour on a coral reef, sunbeams through clear water.', name: 'Fakta Unik', tagline: 'Faceless edukasi, tanpa tokoh tetap', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.dokumenter,
    look: look({ style: 'documentary', genre: 'dokumenter', palette: 'teal-oranye', lighting: 'overcast', camera: 'modern', lens: 'clean', tempo: 'dinamis' }),
    example: 'Lima fakta mengejutkan tentang gurita: punya tiga jantung, darah biru, bisa berubah warna dalam sekejap, sangat cerdas, dan mampu kabur lewat celah sekecil koin.' },
  { id: 'motivasi', category: 'faceless', cover: 'A runner ties her shoes on an empty stadium track just before sunrise, breath visible in the cold air.', name: 'Motivasi Pagi', tagline: 'Video motivasi sinematik', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.motivasi,
    look: look({ style: 'live-action', genre: 'drama', palette: 'pagi-keemasan', lighting: 'golden-hour', camera: 'film35', lens: 'vintage-anamorphic', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Kegagalan bukan akhir. Seorang pelari yang jatuh di lintasan bangkit lagi setiap pagi sebelum matahari terbit, sampai akhirnya ia melewati garis finis.' },
  { id: 'promo-produk', category: 'promo', cover: 'A glass of iced palm sugar coffee with milk swirling into it, on a wooden table beside a rainy window.', name: 'Promo Produk', tagline: 'Iklan pendek produk lokal', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.motivasi,
    look: look({ style: 'live-action', genre: 'auto', palette: 'riviera', lighting: 'soft-window', camera: 'modern', lens: 'clean', aperture: 'f14', tempo: 'tenang' }),
    example: 'Kopi susu gula aren dari kedai kecil di Yogyakarta: biji kopi disangrai, susu dituang perlahan, lalu dinikmati di beranda saat hujan sore.' },
  { id: 'romansa-kota', category: 'drama', cover: 'Two strangers wait at a rainy city bus stop at dusk, one of them holding two umbrellas.', name: 'Romansa Kota', tagline: 'Cerita cinta hangat di kota hujan', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'anime-2d', genre: 'romansa', palette: 'malam-hangat', lighting: 'practicals', aperture: 'f14', tempo: 'mengalir' }),
    example: 'Dua orang asing selalu berteduh di halte yang sama setiap hujan. Mereka tidak pernah bicara, sampai suatu sore salah satunya membawa dua payung.' },
  // — Drama —
  { id: 'perjuangan-ibu', category: 'drama', cover: 'A mother in a headscarf loads trays of homemade cakes onto an old bicycle under a single bulb before dawn, her son asleep beyond the doorway.', name: 'Perjuangan Ibu', tagline: 'Kisah haru pengorbanan orang tua', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'live-action', genre: 'drama', era: '2000s', camera: 'film35', lens: 'warm-vintage', aperture: 'f14', palette: 'pagi-keemasan', lighting: 'practicals', tempo: 'mengalir' }),
    example: 'Setiap subuh Bu Sari bersepeda menjual kue keliling kampung agar anaknya bisa kuliah. Bertahun-tahun kemudian, sang anak pulang memakai toga dan membawakan sepeda baru untuk ibunya.' },
  { id: 'romansa-sekolah', category: 'drama', cover: 'Two high school students in white and grey uniforms share one pair of earphones on a school rooftop at sunset, a rose-colored sky behind them.', name: 'Romansa Sekolah', tagline: 'Cinta pertama masa SMA yang manis', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'anime-2d', genre: 'romansa', era: '2000s', lens: 'halation', aperture: 'f14', palette: 'senja-dongeng', lighting: 'golden-hour', tempo: 'mengalir' }),
    example: 'Setiap Senin Nadia menemukan surat tanpa nama di laci mejanya. Di hari kelulusan ia akhirnya tahu pengirimnya dari tulisan tangan di buku catatan yang dipinjamkan Raka.' },
  { id: 'komedi-keluarga', category: 'drama', cover: 'A dad in a flowery apron stares up at a pancake stuck to the kitchen ceiling while grandma and two kids freeze mid-laugh in a flour-covered kitchen.', name: 'Komedi Keluarga', tagline: 'Kekacauan lucu sehari-hari di rumah', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.jenaka,
    look: look({ style: 'pixar-3d', genre: 'komedi', era: '2020s', lens: 'clean', aperture: 'f4', palette: 'pagi-keemasan', lighting: 'soft-window', tempo: 'dinamis' }),
    example: 'Ayah bertekad memasak sarapan sendiri saat Ibu ke pasar. Dapur berubah jadi medan perang tepung, dan Nenek diam-diam memesan nasi uduk untuk semua.' },
  { id: 'sci-fi-pendek', category: 'drama', cover: 'A courier in a rain-soaked jacket steers a small hovering boat between flooded skyscrapers glowing with magenta and cyan light.', name: 'Sci-Fi Pendek', tagline: 'Fiksi ilmiah singkat dengan twist di akhir', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'live-action', genre: 'petualangan', camera: 'modern', lens: 'anamorphic', aperture: 'f14', palette: 'neon-malam', lighting: 'neon', tempo: 'dinamis' }),
    example: 'Di Jakarta tahun 2089 yang sudah tenggelam, Bima si kurir perahu terbang menerima paket berisi biji padi terakhir di dunia. Ia harus mengantarnya ke kebun rahasia di atap gedung tertinggi sebelum fajar.' },
  { id: 'cinta-dewasa', category: 'drama', cover: 'A man and a woman in their forties sit across a small table in a quiet train station cafe, two cups of tea between them and rain on the window.', name: 'Cinta Dewasa', tagline: 'Romansa matang yang hangat dan berkelas', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'live-action', genre: 'romansa', camera: 'film35', lens: 'warm-vintage', aperture: 'f14', palette: 'kodak-70', lighting: 'soft-window', tempo: 'tenang' }),
    example: 'Dua sahabat lama yang dulu saling suka bertemu lagi di stasiun Yogyakarta setelah dua puluh tahun. Satu sore dan satu kereta terakhir menentukan apakah mereka berani jujur.' },
  // — Anak —
  { id: 'fabel-nusantara', category: 'anak', cover: 'A papercut monkey and a tortoise argue beside a banana tree on a riverbank, layers of paper jungle glowing softly behind them.', name: 'Fabel Nusantara', tagline: 'Fabel klasik dalam diorama kertas berlapis', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'papercut', genre: 'dongeng', aperture: 'f4', palette: 'hutan-zamrud', lighting: 'soft-cross', tempo: 'mengalir' }),
    example: 'Monyet yang licik membagi pohon pisang dan memberi kura-kura bagian bawahnya. Ternyata hanya bagian milik kura-kura yang tumbuh dan berbuah lebat.' },
  { id: 'lagu-anak', category: 'anak', cover: 'A round yellow duckling brushes its tiny teeth at a pastel bathroom sink overflowing with soap bubbles while a little frog cheers.', name: 'Lagu Anak', tagline: 'Video lagu ceria tentang kebiasaan baik', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.lagu,
    look: look({ style: 'lowpoly', genre: 'dongeng', aperture: 'f4', palette: 'pastel-kapas', lighting: 'soft-cross', tempo: 'dinamis' }),
    example: 'Lagu tentang Bebek Kuning yang belajar sikat gigi pagi dan malam, dengan reff "gosok, gosok, kiri kanan" yang mudah ditirukan balita. Setiap bait mengenalkan satu kebiasaan baik.' },
  // — Faceless —
  { id: 'fakta-antariksa', category: 'faceless', cover: 'A ringed gas giant rises over the horizon of an icy moon, a distant sun flaring through its rings.', name: 'Fakta Antariksa', tagline: 'Fakta luar angkasa yang bikin takjub', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.dokumenter,
    look: look({ style: 'live-action', genre: 'dokumenter', camera: 'large-format', lens: 'clean', aperture: 'f11', palette: 'ungu-mistis', lighting: 'contre-jour', tempo: 'dinamis' }),
    example: 'Lima fakta luar angkasa yang jarang diketahui: sehari di Venus lebih lama dari setahunnya, dan Saturnus cukup ringan untuk mengapung di air. Ditutup dengan berapa menit cahaya Matahari sampai ke Bumi.' },
  { id: 'misteri-sejarah', category: 'faceless', cover: 'A farmer kneels in a muddy rice field beside his hoe, brushing volcanic ash from a carved stone emerging from the earth.', name: 'Misteri Sejarah', tagline: 'Penemuan dan teka-teki masa lalu Nusantara', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'documentary', genre: 'noir', camera: 'film35', lens: 'warm-vintage', aperture: 'f4', palette: 'sepia-kenangan', lighting: 'overcast', tempo: 'mengalir' }),
    example: 'Tahun 1966 seorang petani di Sleman mencangkul sawah dan membentur batu berukir. Di bawahnya ternyata terkubur sebuah candi utuh yang tertimbun abu Merapi selama ratusan tahun.' },
  { id: 'motivasi-stoik', category: 'faceless', cover: 'A lone figure in a long coat stands on a rocky cliff above a sea of fog at dawn, perfectly still against the wind.', name: 'Stoik Harian', tagline: 'Kebijaksanaan stoik untuk hidup lebih tenang', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.bijak,
    look: look({ style: 'live-action', genre: 'epik', camera: 'large-format', lens: 'anamorphic', aperture: 'f11', palette: 'kabut-industri', lighting: 'silhouette', tempo: 'tenang' }),
    example: 'Bedakan yang bisa kamu kendalikan dan yang tidak: pendapat orang, cuaca, dan masa lalu bukan milikmu. Satu prinsip stoik dibahas dengan contoh sehari-hari seperti macet dan komentar pedas.' },
  { id: 'tips-keuangan', category: 'faceless', cover: 'A soft low-poly diorama of a tiny house with a glass jar of coins on its porch slowly growing into a small tree.', name: 'Tips Keuangan', tagline: 'Edukasi uang singkat untuk anak muda', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.ceria,
    look: look({ style: 'lowpoly', aperture: 'f4', palette: 'hijau-sawah', lighting: 'soft-cross', tempo: 'dinamis' }),
    example: 'Aturan 50-30-20 untuk gaji pertama: 50 persen kebutuhan, 30 persen keinginan, 20 persen tabungan dan dana darurat. Dijelaskan lewat tiga toples koin yang terisi sedikit demi sedikit.' },
  { id: 'resep-masakan', category: 'faceless', cover: 'Fried rice leaps from a blackened wok over a roaring flame, sliced shallots and a fried egg waiting on a banana leaf beside the stove.', name: 'Resep Kilat', tagline: 'Resep masakan rumahan dalam satu menit', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.ceria,
    look: look({ style: 'live-action', era: '2020s', camera: 'modern', lens: 'clean', aperture: 'f14', palette: 'malam-hangat', lighting: 'practicals', tempo: 'dinamis' }),
    example: 'Nasi goreng kampung ala warung tenda: bawang merah, cabai, dan terasi diulek kasar, lalu nasi dingin diaduk di wajan panas sampai harum. Disajikan dengan telur ceplok dan kerupuk.' },
  { id: 'asmr-alam', category: 'faceless', cover: 'Raindrops fall on broad banana leaves beside a bamboo spout trickling into a mossy stone basin in a misty village garden.', name: 'Suara Alam', tagline: 'B-roll alam menenangkan untuk relaksasi', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.bisik,
    look: look({ style: 'documentary', camera: 'large-format', lens: 'clean', aperture: 'f4', palette: 'hutan-zamrud', lighting: 'overcast', tempo: 'tenang' }),
    example: 'Hujan sore di sebuah desa Sunda: tetes air di daun pisang, pancuran bambu, dan kodok bersahutan di sawah. Narasi berbisik sesekali mengajak penonton menarik napas pelan.' },
  // — Promo —
  { id: 'ulasan-produk', category: 'promo', cover: 'Hands lift a plain white pair of running shoes from a cardboard box on a cozy bed, tissue paper scattered in soft morning light.', name: 'Ulasan Produk', tagline: 'Gaya UGC jujur untuk review dan afiliasi', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.ceria,
    look: look({ style: 'live-action', era: '2020s', camera: 'modern', lens: 'clean', aperture: 'f14', palette: 'pastel-kapas', lighting: 'soft-window', tempo: 'dinamis' }),
    example: 'Ulasan jujur sepatu lari lokal setelah dipakai 30 hari: unboxing, lari pagi, cek sol, lalu kesimpulan cocok untuk siapa. Gaya santai seperti cerita ke teman.' },
  { id: 'kisah-umkm', category: 'promo', cover: 'An older woman slices tempeh paper-thin at a wooden table in a sunlit home kitchen, golden chips cooling on bamboo trays around her.', name: 'Kisah UMKM', tagline: 'Iklan bercerita tentang usaha lokal', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.hangat,
    look: look({ style: 'live-action', genre: 'drama', era: '2020s', camera: 'film35', lens: 'warm-vintage', aperture: 'f14', palette: 'batik-tanah', lighting: 'golden-hour', tempo: 'mengalir' }),
    example: 'Bu Ningsih memulai usaha keripik tempe dari dapur rumahnya di Malang dengan satu wajan. Kini keripiknya dikirim ke seluruh Indonesia, tapi setiap irisan masih dipotong dengan tangan.' },
  // — Edukasi —
  { id: 'belajar-angka-huruf', category: 'edukasi', cover: 'Ten handmade clay apples roll one by one into a woven basket on a bright tabletop, each a slightly different shade of red.', name: 'Belajar Angka & Huruf', tagline: 'Mengenal angka dan huruf lewat benda sehari-hari', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'claymation', aperture: 'f4', palette: 'riviera', lighting: 'soft-cross', tempo: 'montase' }),
    example: 'Hitung bersama dari satu sampai sepuluh: satu apel, dua bebek, tiga balon, sampai sepuluh bintang. Setiap angka muncul bersama benda yang bisa dihitung anak dengan jarinya.' },
  { id: 'sains-anak', category: 'edukasi', cover: 'A curious girl and a small round robot gaze through a giant magnifying glass at a rainbow arching over a city park after rain.', name: 'Sains Cilik', tagline: 'Menjawab pertanyaan "kenapa" anak dengan ceria', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.anak,
    look: look({ style: 'pixar-3d', genre: 'petualangan', lens: 'clean', aperture: 'f4', palette: 'riviera', lighting: 'golden-hour', tempo: 'mengalir' }),
    example: 'Tara bertanya kenapa pelangi muncul setelah hujan. Robot kecilnya, Bolt, mengajak Tara mengecil dan masuk ke dalam tetes air untuk melihat cahaya terpecah menjadi tujuh warna.' },
  { id: 'sejarah-singkat', category: 'edukasi', cover: 'A fleet of wooden sailing ships with woven sails leaves a busy ancient harbor at sunrise, sacks of cloves and nutmeg stacked on the docks.', name: 'Sejarah Singkat', tagline: 'Peristiwa sejarah dalam satu menit', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.dokumenter,
    look: look({ style: 'live-action', genre: 'epik', era: 'kerajaan', camera: 'film35', lens: 'anamorphic', aperture: 'f4', palette: 'sepia-kenangan', lighting: 'golden-hour', tempo: 'dinamis' }),
    example: 'Bagaimana cengkih dan pala dari Nusantara pernah lebih berharga dari emas dan mengubah peta dunia. Kisah jalur rempah dari pelabuhan kuno sampai datangnya kapal-kapal Eropa.' },
  // — Horor & misteri —
  { id: 'urban-legend', category: 'horor', cover: 'Three teenagers with flashlights stand at the gate of an old colonial school building at night, mist curling around a huge banyan tree.', name: 'Legenda Urban', tagline: 'Kisah seram kampung yang aman ditonton', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'live-action', genre: 'horor', era: '1990s', camera: 'film35', lens: 'halation', aperture: 'f14', palette: 'kabut-industri', lighting: 'moonlight', tempo: 'mengalir' }),
    example: 'Setiap malam Jumat terdengar suara gamelan dari aula sekolah tua. Tiga sahabat memberanikan diri masuk dan menemukan penjaga sekolah yang diam-diam berlatih untuk pentas perpisahannya.' },
  { id: 'kasus-misteri', category: 'horor', cover: 'An empty museum gallery at night with a bare picture frame on the wall, a stopped clock and a single desk lamp casting long shadows.', name: 'Kasus Misteri', tagline: 'Narasi detektif ala true crime, tanpa kekerasan', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.misteri,
    look: look({ style: 'live-action', genre: 'noir', era: '1980s', camera: 'film35', lens: 'anamorphic', aperture: 'f14', palette: 'noir', lighting: 'practicals', tempo: 'mengalir' }),
    example: 'Tahun 1987 sebuah lukisan hilang dari museum kota kecil tanpa satu pun pintu dibobol. Detektif tua Pak Hasan memecahkannya hanya dari jam dinding yang berhenti tepat pukul dua.' },
  // — Budaya —
  { id: 'silat-nusantara', category: 'budaya', cover: 'Two silat fighters in batik sarongs face each other in a misty bamboo forest, fallen leaves suspended in the air between them.', name: 'Silat Nusantara', tagline: 'Laga pendekar silat di zaman kerajaan', mode: 'konsisten', aspect: '9:16', narrator: NARRATOR.epik,
    look: look({ style: 'live-action', genre: 'aksi', era: 'kerajaan', camera: 'film35', lens: 'anamorphic', aperture: 'f4', palette: 'hutan-zamrud', lighting: 'contre-jour', tempo: 'dinamis' }),
    example: 'Seorang pendekar muda harus menghadapi gurunya sendiri yang kini mengabdi pada raja lalim. Di akhir duel ia menurunkan kerisnya dan memenangkan hati sang guru tanpa menumpahkan darah.' },
  { id: 'wisata-nusantara', category: 'budaya', cover: 'Sunrise over the jagged green ridges of an island above three curved turquoise bays, wooden boats anchored far below.', name: 'Wisata Nusantara', tagline: 'Jelajah destinasi Indonesia yang memukau', mode: 'cepat', aspect: '9:16', narrator: NARRATOR.dokumenter,
    look: look({ style: 'documentary', genre: 'petualangan', camera: 'large-format', lens: 'clean', aperture: 'f11', palette: 'hijau-sawah', lighting: 'golden-hour', tempo: 'dinamis' }),
    example: 'Tiga hari di Flores: mendaki Pulau Padar saat matahari terbit, berenang di Pantai Merah Muda, lalu menyaksikan danau tiga warna Kelimutu. Ditutup dengan waktu terbaik berkunjung dan perkiraan biaya.' }
];

export const CATALOG = { templates, categories: TEMPLATE_CATEGORIES, styles, genres, eras, tempos, cameras, lenses, apertures, palettes, lighting, framings, moves };
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

# Production Bible, prompt compiler, audit gate, trend intelligence

Status: **menunggu persetujuan** · 2026-10-25 · pemilik: Joseph · penulis: Hermes

## 1. Kenapa

Output sekarang terasa slop karena tiga hal struktural, bukan karena modelnya kurang bagus:

1. **Prompt shot tidak punya isi teknis.** `buildShotPrompt` hari ini menghasilkan
   `<framing>, the camera <move>. <action>` + satu baris `Style:` generik + audio.
   Tidak ada arah cahaya, lensa, tinggi kamera, palet, atau emulasi film — model mengisi
   sendiri dengan default manis-manis, dan tiap shot mengisi dengan cara berbeda.
2. **Tidak ada sistem yang menjaga konsistensi.** Karakter punya sheet, tetapi tidak ada
   tone per scene, tidak ada location plate, tidak ada kalimat gaya yang benar-benar identik.
3. **Tidak ada QC.** Hasil langsung dipakai; tidak ada yang mengukur "apakah gambar ini
   menunaikan isi shot", jadi kesalahan tidak pernah diperbaiki, hanya ditambah.

Tujuan: **input yang disengaja → output yang konsisten → terukur, bukan selera.**

## 2. Goals / non-goals

**Goals**
- Setiap prompt gambar dan video disusun oleh compiler deterministik dari production bible
  (visual + cerita). Slot wajib tidak boleh kosong.
- Konsistensi bisa dites: snapshot kalimat gaya per look, validasi slot, golden prompt.
- Setiap shot punya skor audit 0–100; shot < 70 diperbaiki dengan instruksi spesifik.
- Satu halaman "Tren" yang membaca yang sedang laku per negara, membedah strukturnya, dan
  mengubahnya jadi brief proyek baru (struktur ditiru, cerita baru).

**Non-goals**
- Tidak menyalin/mengunggah ulang footage orang lain. Yang diambil hanya struktur (hook,
  irama, jumlah shot, gaya teks) dan selalu jadi cerita baru.
- Tidak memakai kode berlisensi AGPL/NOASSERTION (inkos, huobao-drama, waoowaoo).
- Tidak membuat platform editor video penuh; timeline yang ada sudah cukup.

## 3. Pendekatan yang dipertimbangkan

| | Cara | Trade-off |
|---|---|---|
| A | 100% deterministik: template + kamus, tanpa LLM untuk teks prompt | Paling konsisten & murah, tapi kaku; cerita tetap butuh LLM |
| B | LLM menulis prompt langsung dengan system prompt besar | Cepat, fleksibel; tapi drift, tidak bisa dites, slop kembali |
| **C** | **Hybrid: LLM mengisi niat terstruktur → compiler menulis teks → audit mengoreksi** | **Dipilih.** Konsisten dan bisa dites, cerita tetap hidup |

C adalah pola yang dipakai `zenstory-ai/drama-skills` (MIT) dan `ChrisChen667788/wind-comic`
(MIT, `lib/vision-audit.ts`). Kita adaptasi idenya, bukan menyalin kodenya.

## 4. Arsitektur

```
        ┌──────────── StoryBible ────────────┐   ┌──────── StyleBible (look) ────────┐
        │ logline, tema, beat, karakter      │   │ stock, lensa, palet, cahaya,      │
        │ (anchor), lokasi, tujuan scene     │   │ grain, komposisi, larangan        │
        └────────────────┬───────────────────┘   └───────────────┬───────────────────┘
                         │                                       │
   LLM draf (niat saja)  ▼                                       ▼
   { beat, action, start→end state, emosi }  ──►  COMPILER  ──►  imagePrompt / videoPrompt
                                                        │         negative / audio / refs[]
                                                        ▼
                                        VALIDATOR (slot wajib + lint bahasa)
                                                        ▼
                                  Flow / OpenRouter  ──►  hasil  ──►  VISION AUDIT
                                                        │              │  < 70 → repair
                                                        ▼              ▼
                                                   Timeline        skor per shot + gate rakit
```

### 4.1 StyleBible (sistem desain visual)

```ts
type LookId = 'film-real' | 'painterly' | 'cel-anime' | 'clay' | 'docu' | 'noir';

type StyleBible = {
  id: LookId; version: number; label: string; tags: string[];
  medium: 'photoreal' | 'illustration' | 'stop-motion' | 'cel';
  stock: string;              // "Kodak Portra 400 emulation, 35mm, halation on highlights"
  lenses: string[];           // ["24mm wide","35mm","50mm","85mm portrait"]
  aperture: string;           // "f/2.0–f/2.8, shallow depth of field"
  palette: { name: string; hex: string; use: 'sky'|'skin'|'ground'|'accent'|'shadow' }[];
  light: { key: string; fill: string; rim: string; temp: string; bestHours: string[] };
  grain: string; halation: string;
  composition: { rule: 'thirds'|'centered'|'low-horizon'; headroom: string; negativeSpace: string };
  forbidden: string[];        // text, logo, split-screen, plastic skin, extra fingers…
  lookdevFrames: string[];    // asset id, 1–3 gambar penentu tone
  styleSentence: string;      // kalimat terkunci, dipakai VERBATIM di semua prompt
};
```

`styleSentence` **dikompilasi** dari field di atas (bukan ditulis tangan), dan di-snapshot
di test. Karena setiap shot memakai kalimat identik, model melihat konteks gaya yang sama
persis di semua shot — ini sumber konsistensi yang bisa dibuktikan.

### 4.2 StoryBible (sistem desain cerita)

```ts
type StoryBible = {
  logline: string; theme: string; tone: string; audience: 'dewasa'|'anak'|'umum';
  structure: { act: 'hook'|'setup'|'turn'|'payoff'; goal: string; beat: string }[];
  characters: { token: string; name: string; anchors: string[]; want: string; need: string; arc: string; sheet?: string }[];
  locations: { key: string; name: string; plate?: string; lookdev?: string }[];
  scenes: { id: string; title: string; goal: string; location?: string; stateIn?: string; stateOut?: string }[];
  rules: { maxShotSec: number; narrationMaxWords: number };  // default 6 s, 12 kata
};
```

`anchors` wajib berupa fakta yang bisa dilihat (bentuk, proporsi, satu ciri, satu material),
bukan kata rasa. Validator menolak anchor yang hanya berisi kata sifat generik.

### 4.3 Compiler

`compileShot(bible, style, scene, shot) → { imagePrompt, videoPrompt, negative, audio, refs[], warnings[] }`

Slot wajib (compiler gagal kalau kosong):
`subject` · `oneAction` (satu rantai kata kerja, tanpa "dan kemudian") · `startState → endState` ·
`lens` · `lightDirection` · `≥2 palette anchors` · `setting` · `styleSentence` · `medium`.

Urutan segmen tetap: **shot grammar → subjek & aksi → state awal/akhir → setting → cahaya →
optik → palet & medium → kebijakan teks → negative → audio**. Semua shot memakai urutan ini.

Lint (gagal = tidak boleh dijalankan):
- kata sifat kosong tanpa bukti ("indah", "megah", "epic", "cinematic" berdiri sendiri);
- kata peralatan kamera (crane, dolly track, rig) — Veo menolaknya;
- lebih dari satu gerakan kamera;
- narasi > 12 kata; nama tokoh wajib dieja sebagai nama, bukan TOKEN;
- shot tanpa perubahan state.

### 4.4 Audit

`auditFrame({ image, expectation }) → { score, dimensions, issues[], repair }`

Dimensi (0–100): `sceneMatch`, `actionMatch`, `moodMatch`, `composition`.
Ambang: ≥75 pass, 50–74 warn, <50 fail. **Skor < 70 → regenerate maksimal 2× dengan `repair`**
(instruksi yang menyebut apa yang kurang, mis. "gate tidak ada di frame; tambahkan pagar kayu
di sepertiga bawah"), bukan re-roll buta. Setelah 2× tetap < 70 → shot ditandai `needs-review`
dan tombol "Rakit" menolak sampai disetujui manusia.
Model: vision via OpenRouter (biaya ±$0,001–0,003 per shot), model dipilih di Pengaturan › Provider.

### 4.5 Tren (halaman baru)

Sumber data:
- **TikTok / Douyin** — layanan `Evil0ctal/Douyin_TikTok_Download_API` (Apache-2.0, 20,9k★, aktif):
  papan hot/weekly/top-100 per region, hashtag, pencarian kata kunci, komentar, transkrip offline,
  MCP. Dijalankan sendiri di Docker + Postgres (di VPS).
- **YouTube** — **YouTube Data API v3 resmi** (`videos.list?chart=mostPopular&regionCode=ID`),
  gratis 10k unit/hari. Instance Piped/Invidious publik sudah tidak andal (525/403 saat diuji).
- **Instagram** — `instaloader` (MIT) untuk hashtag/reel publik saja, tanpa login akun pribadi.

Skor sinyal: `velocity = views / jam sejak publish`, `engagement = (like+comment+share)/views`,
`regionLift` (naik dibanding baseline 7 hari), `nicheMatch` (kata kunci), `freshness`.

Bedah (`deconstruct`): transkrip (ASR), jumlah shot, rata-rata panjang cut, tipe hook
(pertanyaan / kejutan visual / teks hook / POV / before-after), gaya caption, jenis audio
(VO, musik, sound tren), CTA, durasi → `TrendCard` + `CloneBrief`.

`CloneBrief` → tombol **"Jadikan proyek"**: menghasilkan StoryBible kerangka (struktur & irama
mengikuti brief), look yang cocok, dan daftar shot kosong yang siap diisi. Struktur ditiru,
cerita dan aset baru.

Kepatuhan: unduhan hanya untuk analisis, disimpan privat di `/data/trends/`, auto-hapus 30 hari,
tidak pernah diunggah ulang, tidak ditampilkan ke publik; YouTube hanya lewat API resmi.

### 4.6 UI

- **`/tren`**: pilihan negara (ID, US, JP, KR, BR, GB), tab platform, chip niche (AI, cinematic,
  faceless, anak, cerita), jendela waktu (24 jam / 7 hari / 30 hari), urut velocity. Kartu:
  thumbnail, metrik, badge hook, tombol "Bedah" (drawer: peta beat, daftar shot, gaya caption)
  dan "Jadikan proyek".
- **Proyek › tab "Bible"**: editor visual + cerita; menampilkan lookdev frame, location plate,
  anchor karakter, dan peringatan validasi.
- **Kartu shot**: referensi yang dipakai + skor audit; banner gate kalau ada shot < 70.

## 5. Yang diambil dari mana (lisensi)

| Sumber | Lisensi | Yang dipakai |
|---|---|---|
| `zenstory-ai/drama-skills` | MIT | resep 8 bagian aset, lookdev/plate, aturan shot, rubrik review (diadaptasi, bukan disalin) |
| `ChrisChen667788/wind-comic` | MIT | pola audit 4 dimensi + ambang + agregat film |
| `Evil0ctal/Douyin_TikTok_Download_API` | Apache-2.0 | layanan data tren TikTok/Douyin |
| `instaloader/instaloader` | MIT | IG publik |
| `Hao0321/video-autopilot-kit` | MIT | referensi struktur CapCut/ffmpeg untuk bedah irama |
| `Nutlope/hallmark`, `miqdadbadjuber/anti-slop` | MIT | aturan anti-slop teks/UI (kita sudah punya skill hallmark) |

## 6. Testing

- **Compiler**: 6 look × 3 jenis shot (still, aksi, dialog) = 18 golden prompt, di-snapshot dan
  di-diff; validasi slot wajib per kasus; lint punya test positif/negatif.
- **Bible**: skema menolak anchor tanpa fakta visual, scene tanpa goal, karakter tanpa want/need.
- **Audit**: fixture gambar bagus/buruk → pita skor benar; `repair` memuat isu yang terdeteksi;
  two-strike lalu `needs-review`.
- **Tren**: parsing dari rekaman JSON tiap platform (tanpa jaringan di test), skor velocity,
  bedah irama, dan pembuatan `CloneBrief` → StoryBible kerangka.
- **E2E lokal**: server + provider palsu, satu proyek drama dan satu anak, termasuk gate audit.
- **Sabotase** tiap fitur (1 baris kunci) untuk membuktikan test menangkap regresi.

## 7. Tahapan pengiriman

| Tahap | Isi | Biaya |
|---|---|---|
| **P1** | StyleBible 6 look + StoryBible + compiler + validator + remap 33 template + tab Bible | gratis |
| **P2** | Audit gate + repair loop + skor di UI + gate rakit | ±$0,001–0,003 per shot |
| **P3** | Layanan tren (Docker DTK + Postgres) + YouTube API + IG publik + halaman `/tren` + bedah + CloneBrief | gratis (kuota API) |
| **P4** | Rewrite template & skill anti-slop (naskah dan caption) | gratis |

## 8. Risiko dan keputusan

- **ToS/ban**: TikTok/IG membatasi akses tamu; DTK butuh login import untuk pencarian lebih
  dalam. Kita batasi: publik saja, rate limit, cache harian. YouTube lewat API resmi.
- **Biaya audit**: dibatasi 2 percobaan per shot, model vision termurah yang lolos uji.
- **Lisensi**: hanya MIT/Apache-2.0; AGPL dan NOASSERTION dilarang, termasuk sebagai dependency.
- **Storage**: unduhan tren maksimal 30 hari, dihitung di halaman kuota.

Keputusan yang saya ambil sendiri (bisa kamu koreksi):
1. YouTube pakai API resmi, bukan scraping.
2. TikTok/Douyin lewat DTK self-hosted, bukan API berbayar.
3. Instagram publik saja, tanpa akun pribadi.
4. Ambang audit 70, maksimal 2 percobaan, lalu review manusia.
5. Enam look family; `film-real` jadi default untuk drama dan faceless, `painterly` untuk anak.
6. Teks prompt berbahasa Inggris; copy UI dan narasi berbahasa Indonesia.

## 9. Keputusan atas pertanyaan reviewer

Delapan pertanyaan dari pembaca independen, diputuskan di sini supaya tidak ada tebakan saat implementasi.

1. **StyleBible menggantikan lapisan gaya, tapi tidak menghapus gaya bernama.**
   Enam family adalah *grammar*; masing-masing punya `variants` yang menyimpan gaya lama:
   `painterly:[storybook, papercut, wayang]`, `cel-anime:[comic, anime-2d]`, `clay:[pixar-3d, lowpoly]`,
   `film-real:[docu, cinematic-drama]`, `noir:[noir]`. `styleSentence` diturunkan dari (family, variant),
   jadi wayang/comic/papercut tetap punya kalimat sendiri, tapi semuanya patuh grammar family.
   `resolveLook`/`composeStyle` lama tetap ada untuk **board tanpa `bible`** (lihat 2) dan dipensiunkan
   setelah semua template dimigrasi.
2. **Board lama tidak divalidasi ulang dan tidak kehilangan klip.**
   Validator bible hanya berlaku pada board yang punya `bible`. Board tanpa `bible` memakai jalur
   kompatibilitas: `style` tersimpan dipakai apa adanya. Hash klip diberi `promptVersion`: board
   legacy tetap memakai versi 1 (hash lama), board baru versi 2. Tidak ada klip yang di-render ulang
   karena migrasi.
3. **Audit di letak yang paling murah per mode.** `konsisten`: audit **keyframe** sebelum animasi
   (perbaikan = 1 gambar, 0 kredit Flow). `cepat`: audit **3 frame** dari klip setelah render, sebelum
   "Rakit". Satu titik penegakan per mode, bukan dua.
4. **Ekspektasi audit memakai teks + maksimal 3 gambar referensi** (sheet karakter terdekat, location
   plate, lookdev frame). Ini yang bisa menangkap drift identitas; biaya naik jadi ±$0,003–0,006 per
   shot dan masuk laporan usage.
5. **Perbaikan otomatis dibatasi oleh uang.** Perbaikan keyframe (gratis) otomatis. Perbaikan **klip**
   (10 kredit Flow per percobaan) **default menunggu klik**, dengan saklar "perbaiki otomatis" yang
   bisa dinyalakan per proyek. Perbaikan tidak pernah melewati `dailyCreditCap` akun; kalau cap
   tersentuh, shot jadi `needs-review`, bukan mengantre diam-diam. Biaya audit dan perbaikan muncul di
   `/api/quota` dan laporan penggunaan.
6. **Bible ditulis LLM, lalu bisa diedit manusia.** `draft.ts` diubah dari "tulis prompt jadi" menjadi
   "tulis niat": `beat, action, startState, endState, emotion` per shot, plus `want/need/anchors` per
   karakter. Tab Bible adalah editor atas hasil itu. Manusia tidak wajib menulis dari nol, tapi selalu
   bisa menimpa.
7. **Tren: satu stack baru di VPS yang sama, dan P3 boleh rilis YouTube dulu.** DTK + Postgres sendiri
   (port internal, tidak diekspos), Postgres milik DTK terpisah dari data app. `/data/trends` dihitung
   di `measureStorage` sebagai area `trends` dengan pembersihan 30 hari. P3a: YouTube resmi + bedah +
   CloneBrief. P3b: TikTok/Douyin lewat DTK, Instagram publik. Kalau akses tamu TikTok/IG diblokir saat
   implementasi, P3a tetap berguna dan P3b ditunda tanpa memblokir rilis.
8. **Validasi ketat saat render, longgar saat simpan.** `CloneBrief` menghasilkan shot kosong yang sah
   disimpan sebagai `draft`; compiler menolak slot kosong saat render, dan "Rakit" terkunci selama ada
   shot di bawah ambang. Tab Bible menyimpan draf bebas, dengan peringatan slot yang belum lengkap.

Dua yang tetap butuh selera kamu (default saya di bawah, bilang kalau mau lain):
- **wayang/papercut/comic jadi variant** di dalam 6 family, bukan family sendiri.
- **perbaikan klip otomatis mati secara default** supaya tidak ada kredit terbakar tanpa kamu lihat.

# Shotweave Studio

[English](README.md) | **Bahasa Indonesia**

Video cerita bergambar dengan AI, dari awal sampai jadi: tulis ceritanya, pecah jadi scene dan shot,
generate keyframe dan klip, isi suara narasi, bakar caption yang menyala per kata, lalu rakit jadi
film.

Self-hosted, satu container, key dan folder data milikmu sendiri.

> Nama variabel environment dan path di disk masih memakai awalan versi pertama
> (`OPENCREATOR_*`, `~/Documents/nirmalab/...`). Mengganti namanya akan memutus deployment
> yang sedang jalan, jadi untuk sementara dibiarkan.

## Isinya

- **Cerita jadi shot.** Model produksi proyek, scene, dan shot, dengan editor sungguhan: potong,
  geser urutan, trim, zoom, transisi, caption per shot.
- **Dua mesin generate.** Google Flow (gratis, lewat bridge Chrome yang sudah login) atau OpenRouter
  (berbayar, pakai key). Dipilih per proyek atau per job.
- **Mode konsisten.** Character sheet dulu, lalu satu keyframe per shot dengan karakternya menempel,
  baru keyframe yang disetujui dianimasikan. Klip berbayar tidak pernah di-queue ulang oleh edit yang
  tidak mengubah prompt shot itu.
- **Dubbing dan caption.** Suara ElevenLabs per shot, dipercepat agar masuk jendelanya atau dipotong
  dengan fade, dan caption yang menyalakan satu kata pada satu waktu dari timestamp kata itu sendiri.
- **Perakitan.** ffmpeg: crossfade, title card animasi, musik latar yang duck di bawah suara lewat
  sidechain, -14 LUFS, dan render dua tahap supaya memori tetap datar di VPS kecil.
- **Publish.** YouTube (termasuk terjadwal), TikTok dan Meta, sejauh API platformnya mengizinkan.
- **Asisten dan MCP.** Chat proyek dan MCP server, jadi agent bisa mengedit proyek dengan aksi yang
  sama seperti manusia, lengkap dengan konfirmasi dan estimasi biaya.
- **Multi user.** Akun lewat undangan, proyek hanya terlihat oleh pemiliknya, key provider, kuota dan
  penyimpanan diatur admin.

## Kebutuhan

- Node 22 dan pnpm 9
- ffmpeg dengan `libass` dan `libwebp`, python3 dengan Pillow (image sudah memasang semuanya)
- Opsional: akun Google untuk bridge Flow, key OpenRouter, key ElevenLabs

## Menjalankan

```sh
docker build -t creator .
docker run --rm -p 3000:3000 -v creator-data:/data \
  -e OPENCREATOR_ADMIN_EMAIL=you@example.com \
  -e OPENCREATOR_ADMIN_PASSWORD=change-me \
  creator
```

Buka `http://localhost:3000` lalu masuk dengan pasangan itu. Semua yang dibuat aplikasi ada di
`/data`: user, proyek, media hasil generate, key provider, status job.

Dari source:

```sh
pnpm install
pnpm dev:server      # API Fastify di :3000
pnpm dev:web         # Vite untuk shell aplikasi
```

## Konfigurasi

`.env.example` memuat semua variabel dengan catatannya. Yang akan kamu sentuh:

| Variabel | Gunanya |
|---|---|
| `OPENCREATOR_DATA_DIR` | tempat user, proyek, key dan job disimpan |
| `OPENCREATOR_ADMIN_EMAIL` / `_PASSWORD` | admin pertama, dibuat saat boot kalau store masih kosong |
| `STORY_ASSEMBLER`, `STORY_PYTHON`, `MEDIA_FFMPEG` | path ke assembler, python, dan ffmpeg dengan libass |
| `ELEVENLABS_API_KEYS`, `GEMINI_API_KEYS` | opsional; admin juga bisa menempel key di halaman pengaturan |
| `FLOW_BRIDGE_TOKEN`, `CREATOR_URL` | memasangkan bridge Google Flow dengan aplikasi |

Key disimpan di folder data dengan mode 600 dan tidak pernah dikembalikan API, hanya hint pendek.

## Mesin generate

**OpenRouter** yang paling sederhana: satu API key, harga per klip diambil dari daftar model publik,
cek budget sebelum ada yang di-queue.

**Google Flow** tidak punya API publik. Generate hanya bisa lewat Chrome yang benar-benar login,
dengan token reCAPTCHA per request, jadi proyek ini menyertakan bridge: container (atau LaunchAgent
di Mac) yang menjalankan Chrome, mengambil job dari aplikasi, mengemudikan composer Flow, mengunggah
hasilnya, dan melaporkan sisa kredit. Itu yang membuat generate gratis mungkin, dan itu juga bagian
yang rapuh: Flow berganti tampilan bisa memutusnya, dan mengotomasi UI web bisa bertabrakan dengan
ketentuan Google. Jalankan dengan akun sendiri dan risiko sendiri. `deploy/flow-bridge/` memuat
compose file dan catatannya.

## Tes

```sh
pnpm test          # vitest, server + web
pnpm typecheck     # tsc, kedua proyek
```

Suite-nya mencakup aturan storyboard, filter graph assembler, timing caption, jalur auth dan kuota,
serta lapisan aksi MCP. Tes media butuh ffmpeg dengan libass di `PATH`.

## Status

Aplikasi yang dipakai penulisnya setiap hari, dirawat satu orang dan bergerak cepat. Belum ada janji
kompatibilitas antar versi, dan skemanya masih file JSON di folder data, bukan database.

## Lisensi

Apache-2.0, lihat `LICENSE`. `NOTICE-OpenCreator-LICENSE` memuat notice proyek asal fork; kode
sekarang adalah tulis ulang, notice dipertahankan karena lisensi fork memintanya.

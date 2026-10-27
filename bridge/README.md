# flow-bridge

Menghubungkan antrean Flow OpenCreator (`creator.nirmalab.com`) dengan Google Flow lewat
[google-flow-mcp](../../../google-flow-mcp) yang berjalan **di Mac** (Chrome dengan profile login),
bukan di VPS. Server tetap ringan; browser hanya ada di Mac.

```
Studio (web) ──POST /api/flow/jobs──▶ daemon (/data/flow/flow.json)
                                        ▲   │ claim (token)
                    upload mp4 / fail   │   ▼
                         flow-bridge (Mac) ──MCP stdio──▶ google-flow-mcp ──▶ Google Flow
```

## Pakai

```sh
./run.sh            # loop: claim → generate → upload, heartbeat tiap 30 dtk
./run.sh once       # satu job lalu keluar (E2E)
node bridge.mjs status ~/.google-flow-mcp/profiles/acc-01   # cek login + kredit, 0 kredit
node bridge.mjs login  ~/.google-flow-mcp/profiles/acc-02   # login akun baru (burner)
```

Env dibaca dari `~/.config/opencreator/flow-bridge.env` (0600): `FLOW_BRIDGE_TOKEN`, `CREATOR_URL`,
`FLOW_MAX_CREDITS` (default 20 per klip), `FLOW_RESOLUTION` (`360p`/`720p`). Token yang sama ada di
server di `/data/flow/bridge-token` (0600, dibaca per request — rotate = tulis ulang kedua file).

## Pool akun

- Satu folder profile Chrome per akun di `~/.google-flow-mcp/profiles/<acc>`; daftarkan di Studio
  (label, email, folder profile). Server memilih akun `ready` dengan pemakaian harian terendah.
- **Login tiap profile sendiri** (`node bridge.mjs login <dir>`). Jangan menyalin folder profile yang
  sudah login: Google mendeteksi sesi ganda dan mencabut sesi di kedua profile (terjadi 2026-10-23).
- Job yang tidak dilaporkan dalam 25 menit (bridge mati) otomatis kembali ke antrean.
- Error kredit → cooldown 6 jam; 429/rate limit → 30 menit; reCAPTCHA/sign-in → 60 menit. Job
  di-retry di akun lain sampai `maxAttempts`.
- `max_credits` diteruskan ke google-flow-mcp: klip yang quote-nya melebihi batas ditolak sebelum kredit terpakai.

## Test

```sh
node --test test/
```

## Files: `~/Documents/nirmalab/flow` (`FLOW_HOME`)

Every Flow file lives there, not in this repo: `stories/<slug>/` (storyboard.json, shots, final video), `bridge/` (Studio job clips), `exports/` (MCP downloads; `~/FlowExports` symlinks to it), `logs/`. Story video: `node story.mjs <slug> [--limit 1]` then `/usr/bin/python3 py/assemble.py <slug>`.

# axcel-bridge

Mesin **Axcel** (`axcel.cloud`, paket Gold) tidak punya API publik: aplikasi webnya memanggil
`/api/*` di origin sendiri dengan cookie `axcel_sesi` (HttpOnly) plus dua token Cloudflare
Turnstile — satu untuk header `X-Axcel-Token` (umur 30 menit) dan satu lagi di body
`POST /api/generate` (sekali pakai, action `generate`). Token itu hanya bisa dibuat dari sesi
browser sungguhan.

Jadi `axcel.mjs` berjalan **di Mac**, menempel ke Chrome kamu lewat CDP (endpoint yang Chrome
publikasikan di `~/Library/Application Support/Google/Chrome/DevToolsActivePort` saat remote
debugging di `chrome://inspect` menyala), membuat token di tab `axcel.cloud` yang sudah login, dan
menyediakan API lokal yang dipanggil server:

```
Studio (web) ──POST /api/flow/jobs {provider:'axcel'}──▶ server:claimJob('axcel')
                                                          │  HTTP + Bearer token
                                                          ▼
                                              axcel-bridge (Mac) ──CDP──▶ tab axcel.cloud
                                                          │
                                              unduh mp4/png (UA + cookie) ──▶ /data/flow/clips
```

## Pakai

```sh
./axcelctl.sh start         # daemon di background (log $TMPDIR/axcel-bridge.log)
./axcelctl.sh status        # /health: akun, paket, umur token halaman
./axcelctl.sh token         # token baru kalau mau rotate
./axcelctl.sh stop
```

Env di `~/.config/opencreator/axcel-bridge.env` (0600): `AXCEL_BRIDGE_TOKEN` (wajib, ≥16 char),
`AXCEL_BRIDGE_PORT` (8899), `AXCEL_OUT_DIR` (`~/Documents/nirmalab/flow/axcel`), `AXCEL_DEBUG=1`.
Token yang sama diisi di **Pengaturan › Provider › Axcel** (tersimpan di
`/data/providers/axcel.json`, 0600) atau lewat env server `AXCEL_BRIDGE_TOKEN`.

Kalau server Studio ada di VPS (bukan di Mac ini), isi juga:

```
AXCEL_SERVER_URL=https://creator.nirmalab.com
AXCEL_SERVER_TOKEN=<token bridge server, /data/flow/bridge-token>
```

Hasilnya dikirim balik ke antrean yang sama dengan klip Flow
(`POST /api/flow/bridge/jobs/:id/complete`, header `x-nirmalab-provider: axcel`), jadi file tinggal
di server dan tidak bergantung pada disk Mac. Tanpa keduanya, bridge hanya menyimpan file lokal —
cukup untuk dev di Mac.

## Endpoint lokal (semua butuh `Authorization: Bearer`)

| Method | Path | Isi |
|---|---|---|
| GET | `/health` | `{ ok, akun, plan, planAktif, refMedia, tokenUmurMs }` |
| GET | `/account` `/catalog` | passthrough `/api/account`, `/api/catalog` |
| POST | `/generate` | `{ model, prompt, ratio, duration, resolution, audio, inputs }` → `{ jobId }` |
| GET | `/jobs/:id` | passthrough `/api/jobs/{id}` |
| POST | `/wait` | `{ jobId, kind, serverJobId? }` → tunggu selesai + unduh + serahkan ke server |
| POST | `/collect` | `{ jobId, kind, serverJobId? }` → unduh hasil yang sudah selesai + serahkan ke server (yang dipakai worker; `/wait` menyisakan satu request panjang yang kena timeout fetch Node) |
| POST | `/upload` | body biner (`x-nama`, content-type) → `{ assetId }` |
| GET | `/media?url=…` | unduh hasil (mengikuti redirect bertanda tangan ke `media.axcel.cloud`) |

## Yang perlu diketahui (hasil ukur, bukan asumsi)

- **Satu koneksi CDP untuk seluruh proses.** Tiap koneksi baru memunculkan prompt remote debugging
  di Chrome; `getPage()` memakai satu sesi dan menyambung ulang hanya kalau sesi mati.
- **Widget Turnstile harus benar-benar terlihat.** Widget transparan (opacity 0,01) atau berukuran
  nol tidak menghasilkan token. Bridge menaruhnya 320×70 di pojok kanan bawah saat menyelesaikan
  token, lalu menyembunyikannya (opacity 0) setelah dapat.
- **User activation dibutuhkan** untuk action `generate`: evaluate dijalankan dengan
  `userGesture: true`.
- **Server Axcel lambat secara berkala** (15–70 detik per request `/api/auth/me`, pernah 502).
  Timeout di bridge sengaja longgar (me 90 dtk, callApi 120 dtk, CDP 240 dtk) supaya tidak salah
  dilaporkan sebagai "belum login".
- **Unduhan media wajib memakai User-Agent browser**; Cloudflare membalas 403 untuk klien tanpa UA.
- Batas "unlimited" tetap punya kuota harian yang tidak dipublikasi; bridge tidak menembusnya —
  job yang ditolak muncul sebagai error dengan pesan dari Axcel.
- Model per 2026-10-27: `Seedance 2.0`, `Seedance 2.5`, `Veo 3.1 Fast` (video), `Nano Banana Pro`,
  `Seedream 5.0 Pro` (gambar); Gold menambah referensi video/audio (`refvid`, `refaudio`,
  maks 15 detik total).

## Uji

```sh
node --test test/axcel.test.mjs                   # fungsi murni (payload, error, cookie)
cd .. && npx tsx scripts/axcel-e2e.ts             # worker server → bridge → Axcel → file
```

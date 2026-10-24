# flow-bridge di Dokploy — apa yang realistis

Dua proses yang sama seperti di Mac: `bridge.mjs` (claim job → generate → upload) dan
**Chrome beneran yang login ke Google Flow**. Bedanya cuma di mana Chrome-nya jalan.

## Kenapa Chrome, bukan HTTP

Flow mencetak token reCAPTCHA Enterprise **di dalam halaman** untuk setiap generate; RPC mentah
dijawab `UNUSUAL_ACTIVITY`. Jadi engine ini wajib browser terlihat (headful), bukan headless-curl.
Konsekuensinya container butuh Xvfb, dan Chrome di dalamnya memakai software rendering (tanpa GPU).

## Batas yang terukur (jangan diabaikan)

| Fakta | Angka |
|---|---|
| RAM satu Chrome + bridge | 1,0–1,2 GB + 99 MB (diukur di Mac) |
| Resolusi per klip Flow | 10 kredit; akun contoh: 53 kredit → 5 klip |
| VPS sekarang | 4 vCPU, 16 GB (11,6 GB available), load 0,17 |
| IP VPS | 187.53.137.24 — AS47583 Hostinger, Kuala Lumpur (datacenter) |
| flow.google.com dari IP itu | 200, halaman normal (belum diblok) |
| accounts.google.com dari IP itu | 200, sign-in normal |

Artinya: **bisa dipasang, tapi IP-nya datacenter.** Halaman Google terbuka normal sekarang;
yang dinilai Google saat login adalah risk score akun — akun yang biasa dipakai dari Indonesia
tiba-tiba login dari AS47583. Challenge/suspend adalah hasil yang paling mungkin, dan itu
memakan akun, bukan server.

## Build & deploy

```sh
# context harus memuat google-flow-mcp DAN nirmalab-creator/bridge
cd ~/tools
docker build -f nirmalab-creator/deploy/flow-bridge/Dockerfile \
  -t registry.nirmalab.com/nirmalab-flow-bridge:0.1 .
docker push registry.nirmalab.com/nirmalab-flow-bridge:0.1
```

Lalu di Dokploy: **Create Service → Compose**, tempel `docker-compose.yml` ini, isi env
`FLOW_BRIDGE_TOKEN` (harus sama dengan `/data/flow/bridge-token` di app creator) dan `CREATOR_URL`.

## Login sekali (interaktif)

```sh
# set FLOW_LOGIN=1, publish port 6080, redeploy
# buka http://<vps>:6080/vnc.html → login Google di dalamnya → verifikasi HP kalau diminta
# setelah masuk Flow: set FLOW_LOGIN=0, hapus publish port, redeploy
```

Jangan menyalin folder profil yang sudah login dari Mac: Google mendeteksi sesi ganda dan
mencabut sesi di kedua tempat (kejadian 2026-10-23, tercatat di README bridge).

## Kalau akun sering mati

Urutan biaya termurah → termahal:

1. **Jangan farming.** Pakai engine berbayar server-side yang sudah ada di app:
   `server/src/providers/openrouter` (worker 5 s tick, 2 in flight). Harga klip di relay yang
   diukur: `sora-2` $0.034, `MiniMax-H3` $0.037, `wan2.2-t2v-a14b` $1.1.
2. **Proxy residensial per container** (`--proxy-server` sudah didukung `flow-chrome.sh`).
   Hitung bandwidth dulu: Flow app berat, puluhan MB per klip; di $2–5/GB biaya bandwidth
   bisa $0.06–0.30/klip — sering lebih mahal daripada bayar klip.
3. **Flow tetap di Mac rumah** (IP residensial, GPU nyata) dan VPS hanya jadi antrean.
   Ini konfigurasi yang sekarang jalan dan yang paling stabil.

## Verifikasi setelah deploy

```sh
docker logs -f <container>          # harus muncul: Chrome ready on :9333, lalu heartbeat
# di app: Pengaturan › Akun Flow → akun baru status ready + kredit terbaca
```

Job yang tidak dilaporkan dalam 25 menit otomatis kembali ke antrean (lihat README bridge),
jadi container yang mati tidak menghilangkan job — hanya menunda.

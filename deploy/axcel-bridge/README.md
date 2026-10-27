# axcel-bridge (VPS)

Container untuk mesin **Axcel** (`axcel.cloud`, paket Gold) di box yang sama dengan server Studio,
seperti `deploy/flow-bridge/` untuk Google Flow. Tidak ada dependensi ke Mac.

```
Chrome (Xvfb) ──CDP 127.0.0.1:9333── axcel-bridge :8899 ──HTTP── app-quantify (dokploy-network)
        │                                                        │
        └── axcel.cloud (cookie axcel_sesi + Turnstile)          └── POST /api/flow/bridge/jobs/:id/complete
```

## Isi

| Env | Wajib | Arti |
|---|---|---|
| `AXCEL_BRIDGE_TOKEN` | ya | Bearer token yang dikirim server |
| `AXCEL_SESI` | ya | cookie `axcel_sesi` dari browser user (HttpOnly, dicopy, bukan password) |
| `AXCEL_SERVER_URL` | untuk produksi | `https://creator.nirmalab.com` — hasil diunggah ke antrean server |
| `AXCEL_SERVER_TOKEN` | untuk produksi | token `/data/flow/bridge-token` server |
| `AXCEL_PROXY` | sangat dianjurkan | `http://user:pass@host:port` — Chrome memakai `--proxy-server` |
| `AXCEL_LOGIN=1` | opsional | mode login manual: noVNC di `:6080`, bridge tidak start |
| `AXCEL_BIND` | – | `0.0.0.0` (default image) supaya bisa dijangkau container lain |

Image mengeset `AXCEL_CDP_URL=http://127.0.0.1:9333`, `AXCEL_CHROME_PROFILE=/data/chrome`,
`AXCEL_OUT_DIR=/data/axcel`, volume `/data`.

## Build & jalankan (di VPS)

```sh
cd /root/nc-axcel                      # rsync dari repo: bridge/ + deploy/
docker build -f deploy/axcel-bridge/Dockerfile -t nirmalab-axcel-bridge:1 .
docker run -d --name axcel-bridge --restart unless-stopped \
  --network dokploy-network -v axcel-data:/data --env-file container.env \
  nirmalab-axcel-bridge:1

# token yang sama ditulis ke volume app (0600) supaya UI/worker memakainya
printf '{"url":"http://axcel-bridge:8899","token":"%s"}\n' "$TOK" \
  > /var/lib/docker/volumes/open-creator-data/_data/providers/axcel.json
chmod 600 /var/lib/docker/volumes/open-creator-data/_data/providers/axcel.json
```

Cek: `GET /api/providers` harus menampilkan `axcel.configured: true` + `health.akun`.

## Batasan yang terukur (2026-10-27)

- **Sesi cookie berfungsi dari IP VPS** (`/api/auth/me` 200, `/api/account` 200) — tidak terikat IP.
  Cookie kedaluwarsa ±2026-11-25; sebelum itu salin ulang dari Chrome user ke `AXCEL_SESI`.
- **Turnstile `action: token` (invisible site key) berhasil** di VPS → page token & pembacaan jalan.
- **Turnstile `action: generate` (main site key) TIDAK pernah keluar** dari IP datacenter
  (timeout 45–60 dtk, bahkan dengan WebGL SwiftShader, UA wajar, `navigator.webdriver=false`).
  Tanpa token itu `POST /api/generate` selalu `TURNSTILE`. Jadi **generate butuh proxy residensial**
  (`AXCEL_PROXY`); baca/riwayat/akun tetap jalan tanpa proxy.
- Bridge menandai kegagalan itu `final` pada percobaan pertama, sehingga server langsung
  **failover ke Google Flow** (job Flow baru, prompt/aspect/durasi sama) — terbukti di produksi:
  `job_f5484c8db6c7b225` (axcel, failed) → `job_a44e14a8766092a5` (flow, done 782.600 B).

## Operasional

```sh
docker logs axcel-bridge | tail -50        # bridge + entry
docker exec axcel-bridge sh -c 'curl -s -H "Authorization: Bearer $AXCEL_BRIDGE_TOKEN" \
  http://127.0.0.1:8899/health'
```
Restart aman (`docker restart axcel-bridge`); entry membersihkan lock X dan Singleton Chrome.

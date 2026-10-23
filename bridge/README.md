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

# Providers, media and quota (contract)

Owners: S1 = server providers, S2 = server media/storage, W1 = web shell/media, W2 = web providers UI.
Parent writes `GET /api/quota` after S1+S2 land (it composes their functions).

## 1. Engines (S1 server, W2 web)

```ts
type ProviderId = 'flow' | 'openrouter' | 'axcel';
type Engine = { provider: 'flow' } | { provider: 'openrouter'; model: string } | { provider: 'axcel'; model: string };
Storyboard.engine?: { image?: Engine; video?: Engine };   // default: flow for both (today's behaviour)
```
- Image engine makes character sheets (`kind: 'character'`) and keyframes / stills (`kind: 'image'`).
- Video engine makes clips (`kind: 'video'`); konsisten mode passes the approved keyframe as `first_frame`.
- `FlowJob` gains `provider?: ProviderId` (absent = `'flow'`), `model?: string`; `job.result.costUsd?: number`.
- The Mac bridge must only ever claim `provider: 'flow'` jobs (filter in the store's claim, tested).
- `POST /api/flow/jobs` accepts optional `provider` + `model` (Studio).
- Pool rotation/daily caps apply to flow jobs only.

### OpenRouter worker (server process, no Mac)
- Runs inside the server every 5 s, at most 2 jobs in flight, only when a key is configured.
- image/character: `POST https://openrouter.ai/api/v1/images` `{ model, prompt, aspect_ratio, n: 1, input_references?: [{type:'image_url', image_url:{url:<data URL>}}] }`
  (references = the cast sheets attached to the job, when the model accepts `input_references`). Response `data[0].b64_json` (+ `media_type`), `usage.cost`.
- video: `POST https://openrouter.ai/api/v1/videos` `{ model, prompt, aspect_ratio, duration, resolution?, generate_audio?, frame_images?: [{ type:'image_url', image_url:{ url:<data URL of keyframe> }, frame_type:'first_frame' }] }`
  - `duration` = the model's supported duration closest to 6; `resolution` = '720p' when supported; `generate_audio: true` when the model supports audio (narration is in the prompt).
  - Poll `GET /api/v1/videos/{id}` every 10 s up to 15 min (status pending|in_progress|completed|failed|cancelled|expired); download `GET /api/v1/videos/{id}/content?index=0` with the key.
- Result written under `/data/flow/clips/<jobId>.<ext>` and completed through the same store method the bridge uses (so stories/Studio collect it unchanged). Errors → the store's fail path with a plain message (402 → "Saldo OpenRouter habis", 401 → "API key OpenRouter ditolak").
- Model capabilities come from `GET /api/v1/videos/models` and `GET /api/v1/images/models` (public), cached 1 h on disk.


### Axcel worker (Mac bridge, plan Gold)
- Axcel (`axcel.cloud`) has **no public API**. The client half lives in `server/src/providers/axcel.ts`;
  the calls are made by `bridge/axcel.mjs` on the Mac, which mints the Cloudflare Turnstile tokens in
  the user's logged-in Chrome (`X-Axcel-Token` header + `turnstile` in the generate body) — see
  `bridge/README.md`.
- `POST /api/flow/jobs` accepts `provider: 'axcel'` with `model` one of `Seedance 2.0`, `Seedance 2.5`,
  `Veo 3.1 Fast`, `Nano Banana Pro`, `Seedream 5.0 Pro` (Axcel's own names, not OpenRouter slugs).
- Worker: one job at a time, claims `provider: 'axcel'`; image/character → `op: 't2i'` (references → `i2i`),
  video → `t2v` (keyframe → `i2v`, uploaded through `POST /uploads` first). Body shape, captured from the
  web app: `{model, op, prompt, ratio, duration, resolution, audio, inputs, idempotencyKey, bahasa, turnstile}`.
  `duration` snaps to the model's list (closest to the job's `durationSec`), `resolution` is 480 today,
  `audio: true` for video (narration lives in the prompt).
- Result: the bridge waits, downloads the signed media URL (needs a browser User-Agent) into
  `~/Documents/nirmalab/flow/axcel/<jobId>.<mp4|png>` and the worker completes the job with that path
  (same store method as Flow/OpenRouter, so stories and Studio collect it unchanged).
- No per-clip price: the Gold plan is a flat subscription, so no budget check; Axcel's own refusal
  (daily quota, moderation) arrives as a fail message, `final` when a retry cannot help.
- Provider API: `GET /api/providers` adds `axcel: { configured, url, tokenHint?, health?, error? }`;
  `PUT /api/providers/axcel {url?, token?}`; `POST /api/providers/axcel/test`;
  `GET /api/providers/axcel/models`. Token stored in `/data/providers/axcel.json` (0600), env
  `AXCEL_BRIDGE_TOKEN` / `AXCEL_BRIDGE_URL` win.

### Provider API (admin)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/providers | – | `{ flow: { accounts, credits: number|null, online }, openrouter: { configured, keyHint?: '••••abcd', defaults: { image?: string, video?: string } } }` |
| PUT | /api/providers/openrouter | `{ apiKey?: string \| null, defaults?: { image?: string \| null, video?: string \| null } }` | same as GET `.openrouter` |
| POST | /api/providers/openrouter/test | – | `{ ok: true, balance: { usedUsd, limitUsd: number\|null, remainingUsd: number\|null } }` or 400 `{error}` |
| GET | /api/providers/openrouter/models | – | `{ image: ModelInfo[], video: ModelInfo[] }` |

```ts
type ModelInfo = { id: string; name: string; aspects: string[]; durations?: number[]; audio?: boolean; firstFrame?: boolean;
  references?: boolean; usdPerClip?: number | null /* video: 6 s (closest duration) 720p with audio when known */; usdPerImage?: number | null; priceLabel: string /* "±$0,30 / klip 6 dtk" */ };
```
- Key stored in `/data/providers/openrouter.json` (mode 0600). Never returned, never logged; `keyHint` = last 4 chars.
- Budget: rendering with an OpenRouter video engine estimates `clips × usdPerClip`; when the balance is known and lower → 402 `BUDGET` with "Butuh ±$X, saldo OpenRouter $Y" (force overrides). Flow credit check unchanged for flow.
- Exported for the quota endpoint: `openRouterBalance(dataDir): Promise<{usedUsd, limitUsd, remainingUsd} | null>` (cached 60 s).

## 2. Media + storage (S2 server, W1 web)
- Image endpoints accept `?w=` in {160, 320, 480, 720, 1080}: response is `image/webp` resized to that width (never upscaled), generated with ffmpeg, cached at `/data/cache/img/<sha1(path+mtime+w)>.webp`. Without `w`: original bytes (content type from magic bytes). `cache-control: private, max-age=31536000, immutable` when the URL has `v=`; else `private, max-age=300`.
  - `/api/stories/:id/shots/:shotId/frame`, `/api/stories/:id/cast/:token/image`, `/api/stories/templates/:id/cover`, `/api/flow/jobs/:id/file` (image jobs only).
- Posters: `GET /api/stories/:id/video/poster?w=` and `GET /api/stories/:id/shots/:shotId/poster?w=` → webp of the frame at 1 s (or the middle for clips < 2 s) of that video, cached like above; 404 when no video.
- Collect: story files made from a job result are hard links to `/data/flow/clips/<file>` (fallback copy across devices) — one copy on disk.
- `measureStorage(dataDir): Promise<{ usedBytes: number; byArea: { stories: number; clips: number; cache: number; covers: number; other: number }; diskFreeBytes: number | null }>` in `server/src/media/storage.ts` (hard-linked files counted once).
- `cleanupStorage(dataDir, deps)`: remove `final.mp4.prev`, image cache files older than 30 days, flow clip files of jobs that no longer exist or failed, replace byte-identical duplicates between `stories/` and `flow/clips/` with hard links. Returns `{ freedBytes, linked, removed }`. Runs once a day in the server + `POST /api/storage/cleanup` (admin). `GET /api/storage` (admin) returns `measureStorage`.

### Motion QC of finished clips (free)
Every clip that passes `qc()` in `collect()` (all modes) is checked by `bridge/py/clipqc.py` (numpy + ffmpeg, no credits): a scene melting into
another mid-clip, a pale border growing in, a frozen/near-still clip, the camera drifting back, a hard cut or scale jump, and (konsisten) a clip
that does not open on its keyframe. The server runs it as `nice python3 clipqc.py …` one at a time with a 20 s kill (`server/src/media/motion-qc.ts`);
a missing python/numpy, a timeout or garbage output means *no verdict* and the clip is used as before. The verdict is `ShotState.motion`
(`status ok|warn|fail`, `score`, `reasons` in plain Indonesian, optional free `suggest` = `trimOut`/`trimIn`/`zoom`) and belongs to one take (`motionJobId`).
Only `fail` sets `needsReview` (the existing gate; `approve-audit` clears it). It never queues a render. Old projects: `POST /api/stories/:id/motion-check`
(admin, free, idempotent, stores verdicts only, does not gate a finished project).
Limits (measured on one film, 21 shots, thresholds tuned on the same shots, no human hold-out; only the painterly look tested): a small identity glitch
(a hood going up in 0.2 s) is **not** found. Measure speed and memory on the production image: `docker exec <c> python3 /app/bridge/py/clipqc_bench.py`.

## 3. Quota (parent; W1 consumes)
`GET /api/quota` (member):
```ts
{ flow: { credits: number | null; usedToday: number; capToday: number | null; accounts: number; online: boolean },
  openrouter: { configured: boolean; remainingUsd: number | null; usedUsd: number | null },
  storage: { usedBytes: number; diskFreeBytes: number | null } }
```

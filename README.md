# Shotweave Studio

**English** | [Bahasa Indonesia](README.id.md)

Illustrated AI story videos, end to end: write the story, break it into scenes and shots, generate
keyframes and clips, dub the narration, burn word-synced captions, and assemble the film.

Self-hosted, one container, your own keys and data directory.

> Environment variable and on-disk path names still carry the prefixes from the first
> version (`OPENCREATOR_*`, `~/Documents/nirmalab/...`). Renaming them would break running
> deployments, so they stay for now.

## What is in it

- **Story to shots.** A production model of project, scene and shot, with a real editor: cut,
  reorder, trim, zoom, transitions, per-shot captions.
- **Two generation engines.** Google Flow (free, through a signed-in Chrome bridge) or OpenRouter
  (paid, key based). Chosen per project or per job.
- **Consistency mode.** Character sheets first, one keyframe per shot with the cast attached, then
  animate the approved keyframe. Paid clips are never re-queued by an edit that does not change the
  shot's prompt.
- **Dubbing and captions.** ElevenLabs voice per shot, sped up to fit its window or cut with a fade,
  and captions that light one word at a time from the words' own timestamps.
- **Assembly.** ffmpeg: crossfades, an animated title card, a music bed ducked under the voice with
  a sidechain, -14 LUFS, and a two-pass render that keeps memory flat on a small VPS.
- **Publishing.** YouTube (including scheduled), TikTok and Meta, where the platform API allows it.
- **Assistant and MCP.** A project chat and an MCP server, so an agent can edit a project with the
  same actions a person has, confirmations and cost estimates included.
- **Multi user.** Invite-only accounts, a project visible only to its owner, admin-managed provider
  keys, quotas and storage.

## Requirements

- Node 22 and pnpm 9
- ffmpeg built with `libass` and `libwebp`, python3 with Pillow (the image installs both)
- Optional: a Google account for the Flow bridge, an OpenRouter key, an ElevenLabs key

## Run it

```sh
docker build -t creator .
docker run --rm -p 3000:3000 -v creator-data:/data \
  -e OPENCREATOR_ADMIN_EMAIL=you@example.com \
  -e OPENCREATOR_ADMIN_PASSWORD=change-me \
  creator
```

Open `http://localhost:3000` and sign in with that pair. Everything the app creates lives under
`/data`: users, projects, generated media, provider keys, job state.

From source:

```sh
pnpm install
pnpm dev:server      # Fastify API on :3000
pnpm dev:web         # Vite dev server for the app shell
```

## Configuration

`.env.example` lists every variable with a note. The ones you will touch:

| Variable | Why |
|---|---|
| `OPENCREATOR_DATA_DIR` | where users, projects, keys and jobs are stored |
| `OPENCREATOR_ADMIN_EMAIL` / `_PASSWORD` | the first admin, created on boot if the store is empty |
| `STORY_ASSEMBLER`, `STORY_PYTHON`, `MEDIA_FFMPEG` | paths to the assembler, python and an ffmpeg with libass |
| `ELEVENLABS_API_KEYS`, `GEMINI_API_KEYS` | optional; an admin can also paste keys in the settings page |
| `FLOW_BRIDGE_TOKEN`, `CREATOR_URL` | pairing the Google Flow bridge with the app |

Keys are stored under the data directory with mode 600 and are never returned by the API, only a
short hint.

## Generation engines

**OpenRouter** is the simple one: an API key, per-clip prices from the public model list, a budget
check before anything is queued.

**Google Flow** has no public API. It only generates through a real signed-in Chrome, with an
in-page reCAPTCHA token per request, so this project ships a bridge: a container (or a Mac
LaunchAgent) that runs Chrome, takes jobs from the app, drives the Flow composer, uploads results
back, and reports the credit balance. It is what makes free generation possible, and it is also the
fragile part: a Flow redesign can break it, and automating a web UI may conflict with Google's
terms. Run it with your own account and at your own risk. `deploy/flow-bridge/` has the compose file
and the notes.

## Tests

```sh
pnpm test          # vitest, server + web
pnpm typecheck     # tsc, both projects
```

The suite covers the storyboard rules, the assembler graph, caption timing, the auth and quota
paths, and the MCP action layer. Media tests need an ffmpeg with libass on `PATH`.

## Status

A working app its author uses daily, maintained by one person and moving fast. There are no
compatibility promises between versions yet, and the schema lives in JSON files under the data
directory rather than in a database.

## License

Apache-2.0, see `LICENSE`. `NOTICE-OpenCreator-LICENSE` carries the notice of the project this app
was originally forked from; the current code base is a rewrite, and the notice is kept because the
fork's licence asks for it.

# Project assistant, scene-to-shot AI, and MCP — design

Date: 2026-10-27 · Branch `feat/project-assistant` (worktree `.worktrees/project-assistant`)

## 1. Intent

Joseph produces AI story videos as projects (Proyek → Scene → Shot). Today the creative work after
the first draft is manual and partly broken:

- A scene can only be split into shots once, at the first draft. "Tambah shot" adds an empty
  placeholder; no AI helps break a scene into shots.
- Bible shots compile their prompt from `shot.intent`, but the shot sheet edits `shot.prompt`, which
  the compiler ignores. Editing a bible shot's prompt silently changes nothing. Manually added shots
  have no intent and fall back to the old prose path outside the bible.
- Characters live in two places (Breakdown `board.characters`, Bible `bible.characters`) that do not
  sync. The compiler reads the bible; the character-sheet prompt reads `board.characters`.
- There is no autocomplete for characters, locations or shots.
- There is no way to steer a project in plain language ("generate shot 3", "make scene 2 four shots",
  "give Laras a red scarf"), neither inside the app nor from Claude/Cursor/OpenCode.

He wants one place, on the right of every project, where he types an instruction scoped to that
project and the app does it; and the same abilities exposed over MCP so external assistants can drive
the app. Output must stay bible-consistent (the anti-slop work of P1–P4 must not be bypassed).

## 2. Goals

1. **Text model**: OpenCode Go as the app's assistant LLM. Default `glm-5.3`, fallback
   `glm-5.3-flash`, then `beam-free`. Verified 2026-10-27 with a real two-tool instruction: glm-5.3,
   glm-5.3-flash, beam-free and deepseek-v4-pro made both calls; deepseek-v4.1-flash dropped one.
   Pollinations stays the free fallback for the existing draft path.
2. **One action layer** (`server/src/assistant/actions.ts`): typed, validated project operations used
   by the chat panel, the MCP server and the new UI buttons. No second implementation of any edit.
3. **Scene → shots with AI**: "Pecah jadi shot" on a scene (and the action `breakdown_scene`) asks the
   LLM for N shot intents grounded in the bible (scene goal, location, character tokens, rules),
   validates them through the compiler, and inserts them.
4. **Bible correctness**: the shot sheet of a bible shot edits intent fields (subjek, aksi, keadaan
   awal, keadaan akhir, emosi, framing, gerak kamera, narasi) and shows the compiled prompt read-only
   ("Prompt yang dikirim"). A shot added to a bible board starts with an intent skeleton. Legacy
   (no-bible) boards keep today's prompt textarea unchanged.
5. **One character source**: on bible boards, Breakdown edits `bible.characters` (name, token,
   anchors, want/need/arc); `board.characters` is derived from it on save. The Bible tab stops
   carrying a second character editor and links to Breakdown. Legacy boards unchanged.
6. **Autocomplete**: a shared `MentionTextarea` — `@` characters (name + sheet avatar), `#` locations,
   and in chat `/` shots and scenes ("shot 3", "scene 2"). Keyboard navigable, mouse optional.
7. **Character references**: each character card in Breakdown shows its sheet when made, a free
   "Buat sheet" action (one image job for that character only), and "Unggah referensi" (image stored
   in the story dir). Uploaded references are attached as image inputs for OpenRouter engines. Flow's
   MCP cannot attach arbitrary uploads (`reference_media_ids` must already be Flow media), so for Flow
   the card says plainly that the upload is used with OpenRouter and that Flow uses the generated
   sheet.
8. **Project chat panel**: right column on `/cerita/:id` (collapsible, ~360 px; below `lg` a
   "Asisten" button opens it as a Sheet). Per-project history persisted. Each assistant turn lists what
   it changed as chips ("Shot 3 diubah") with **Batalkan** (undo to the snapshot before that turn).
   Anything that spends credits or money is proposed with its cost and needs one click "Jalankan".
   The user can attach an image or point at project media ("pakai keyframe shot 2").
9. **MCP server**: Streamable HTTP at `https://creator.nirmalab.com/mcp`, bearer personal access
   tokens created in Settings › Integrasi (shown once, stored hashed, revocable). Tools = the action
   layer + `list_projects`, `get_project`, `create_project`. Spending tools need `confirm: true`.
10. **Tutorial** in Settings › Integrasi: copy-paste setup for Claude Code, Claude Desktop, Cursor,
    OpenCode and Codex, each verified against that client's current docs at build time, plus a "Tes
    koneksi" button that calls the server's own tools/list with the token.
11. **Studio vs Template** clarity: one line on each page saying what it produces (Template = recipe to
    start a project; Studio = one clip or still, no project).
12. **Skills inside the assistant**: our existing skills (cinematic quality, cinematic footage,
    anti-slop copywriting, viral hooks, P4 lint list) are condensed into a small skills pack that the
    assistant always reads and MCP exposes as resources, so instructions come out bible-consistent.
13. **Chat looks like Claude/ChatGPT**: streamed replies, markdown, tool-step lines, change chips,
    image upload (button, paste, drag-drop) with thumbnails.

## 3. Non-goals

- Axcel. The uncommitted Axcel bridge files in the main checkout are not touched, merged or
  committed by this work (the user decides their fate separately).
- Video/audio reference inputs for Flow (no API path today).
- Realtime multi-user editing, voice chat.
- Changing who may edit projects: story mutations are admin-only today; the assistant, MCP tokens and
  new endpoints follow the same rule.

## 4. Anti-goals (failure even if it "works")

- The chat or an MCP client spends Flow credits or OpenRouter money without an explicit confirm.
- An assistant edit re-queues a paid clip whose effective prompt did not change.
- The assistant writes prompt text directly and bypasses the bible compiler.
- A second place to edit characters, or a feature that exists twice.
- An action reaches outside the project it is scoped to.
- Keys or tokens appear in responses, logs, the repo, or chat.

## 5. Approaches considered

| | What | Trade-off |
|---|---|---|
| A | Chat panel calls the LLM with tools mapped 1:1 to existing REST routes | Fast, but REST routes are coarse (whole-storyboard PUT); every tool would re-implement diffing; MCP would need a third copy |
| **B (chosen)** | One action layer of small typed operations over `StoryService`; chat, MCP and new buttons all call it | One place for validation, scoping, cost gating, undo snapshots; slightly more upfront work |
| C | Only MCP; no in-app chat (let Claude Desktop be the chat) | Cheapest, but the user explicitly wants a chat on every project page |

Transport for MCP: remote Streamable HTTP with bearer tokens (works from any machine, no install).
A stdio package was rejected: it needs Node on the client and a second release channel. Clients that
only speak stdio use the `mcp-remote` shim documented in the tutorial.

## 6. Decisions

6.1 **LLM client** `server/src/llm/opencode.ts`: OpenAI-compatible chat completions at
`https://opencode.ai/zen/go/v1`, headers `Authorization: Bearer`, a normal `User-Agent`, and a fresh
`x-opencode-session: ses_<12 hex><14 alnum>` per request (Go rejects requests without it,
`400 MissingSessionID`). Model chain glm-5.3 → glm-5.3-flash → beam-free on 429/5xx/timeout (60 s).
Key stored at `/data/providers/opencode-go.json` (0600, write-only, `keyHint` = last 4). Settings ›
Provider gets a "Model teks" block: key field, model choice from a verified allowlist, "Tes" button
(one tiny completion). The key is placed on the server through the settings API, never echoed.

6.2 **Actions** (`server/src/assistant/actions.ts`), every action `(ctx, storyId, input) → result`:

| Action | Mutates | Spends |
|---|---|---|
| `get_project` (summary: scenes, shots numbered globally, characters, locations, look, status, costs) | — | — |
| `edit_shot` {shot, intent fields, narration, framing, move, silent} | yes | — |
| `add_shot` {scene, after?, intent} / `remove_shot` / `move_shot` | yes | — |
| `breakdown_scene` {scene, count 2–8, brief?} → LLM intents, compiled before insert | yes | LLM tokens only |
| `edit_scene` {scene, title, goal, location} / `add_scene` / `remove_scene` | yes | — |
| `edit_character` {token, name, anchors, want, need, arc} / `add_character` | yes | — |
| `edit_location` / `add_location` | yes | — |
| `set_look` {family, variant, …} | yes | — |
| `make_sheet` {token} · `redraw_frame` {shot, note?} · `prepare` {scene?} | queues jobs | Flow 0 credits / OpenRouter $ |
| `render` {shot? scene?} · `assemble` | queues jobs | Flow credits / OpenRouter $ |

Shots and scenes are addressed by the global number the UI shows ("shot 3"), resolved server-side to
ids; unknown numbers return a plain error listing valid ones. Every mutation goes through
`StoryService.update` (same validation, same promptHash rule that keeps paid clips). Before the first
mutation of a turn the action layer snapshots the storyboard (ring of 20 per story,
`stories/<id>/snapshots/`), which is what **Batalkan** restores. Spending actions without
`confirm: true` return `{ needsConfirm, estimate }` and do nothing.

6.3 **Assistant endpoint** `POST /api/stories/:id/assistant` {message, attachments?, confirm?:
pendingId} → runs a tool loop (max 6 model steps, 90 s) with the actions as tools and a system prompt
holding the project summary, bible rules and "never write prompt text; edit intent". Returns
`{ reply, changes: [{label, undoId}], pending: [{id, label, estimate}] }`. History at
`stories/<id>/assistant.json` (last 50 turns; attachments as story media). `GET` returns history.
`POST …/assistant/undo/:undoId` restores. If no text model is configured, the panel says so in one
line with a link to Settings › Provider and the rest of the page works.

6.4 **Scene breakdown prompt**: input = bible (logline, structure, scene goal, location plate,
characters with anchors, rules: max shot sec, narration ≤12 words), neighbouring shots for
continuity, count, optional brief. Output = JSON array of intents. Each intent is compiled; a
`ShotCompileError` or lint issue is fed back once; still failing → plain error, nothing inserted.

6.5 **MCP** `server/src/mcp/`: `@modelcontextprotocol/sdk` (1.30.x, same major as google-flow-mcp)
`McpServer` + Streamable HTTP transport mounted on Fastify at `/mcp` (POST/GET/DELETE), stateless
mode. Auth: `Authorization: Bearer nc_<random>`; tokens at `/data/mcp/tokens.json` (0600) as
`{id, userId, name, sha256, createdAt, lastUsedAt}`; only admins may hold tokens; a revoked token or
a removed user is rejected. Rate limit per token. Tool descriptions in English (clients' models read
them), results in plain JSON with Indonesian labels where shown to a person.

6.6 **Settings › Integrasi** (new tab, admin): token list (name, created, last used, Cabut), "Buat
token" (shown once with Salin), then a client picker (Claude Code / Claude Desktop / Cursor /
OpenCode / Codex) with the exact snippet pre-filled with the URL and a `<TOKEN>` placeholder (never
the real token in a snippet that persists), and "Tes koneksi".

6.7 **UI placement** (project page): header + tabs unchanged; content area becomes two columns at
`lg+` (tabs content | assistant). The assistant column is collapsible and remembers its state.
Composer = `MentionTextarea` with `@ # /`, attach button, send. Empty state = three example
instructions as clickable chips, built from the actual project (real shot numbers and names).

## 7. Constraints

House rules from the shipping skill apply: Indonesian UI (English for prompt/look fields), no native
`<select>`/date/radio/checkbox, three states on every screen, placeholders on every field, bounded
media, one purpose per page, TDD with a sabotage per key line, full suite + both typechecks green,
`skipped` = 0, live walk with a temporary admin removed afterwards, user projects opened read-only in
walks. Secrets: OpenCode key and MCP tokens only in 0600 files on `/data`, written through the API or
ssh stdin, never printed.

## 8. Verification (definition of done)

1. Unit + route tests for every action (including scope: an action cannot touch another story), the
   confirm gate, undo, number→id resolution, the breakdown validation loop, LLM fallback chain (fake
   fetch), token hashing/revocation, MCP auth.
2. Local E2E on a copy of a real story: chat "pecah scene 2 jadi 3 shot" and "di shot 1 ubah emosinya
   jadi lega" through the **real** OpenCode Go API; assert the storyboard changed as asked, compiled
   prompts lint clean, no paid clip re-queued, Batalkan restores byte-identical storyboard.
3. MCP E2E with a real client: `claude mcp add --transport http` against the local server, `claude mcp
   list` shows connected, and a scripted SDK client calls `get_project` + `edit_shot` + a spending tool
   without confirm (must refuse).
4. Deploy, live walk of the project page (chat panel, autocomplete, shot sheet intent fields,
   Breakdown character card) at 1440 and 390, Settings › Integrasi token create/revoke, then log
   checks (no 5xx) and cleanup.

## 9. Decisions from the builder check (builder's calls, approved with this doc)

9.1 **Character single source without re-renders.** On existing bible boards `board.characters[T]`
keeps its current `look` text frozen (it is what the sheet hash was built from). Breakdown edits the
bible card; `look` is rebuilt from `name + anchors` **only when that character's anchors change**,
and the card warns first: "Mengubah tampilan membuat ulang sheet + keyframe N shot (gratis di Flow)
dan klip M shot (±X kredit)". Renaming, want/need/arc edits never touch `look`.

9.2 **Undo restores takes too.** A snapshot = `storyboard.json` **and** the shot take state from
`story.json` (status, jobId, promptHash, frame, audit). Restoring both brings a paid clip back to
`done` instead of pending. Undo of a turn is allowed only while the board revision still equals the
revision right after that turn; otherwise it refuses with "Ada perubahan setelah ini — batalkan
yang terbaru dulu". Ring of 50 snapshots per story.

9.3 **No lost updates.** Storyboard gets a `rev` counter. `PUT /api/stories/:id` and every action
take the `rev` they read; a mismatch returns 409 `STALE`. Tabs keep saving through `PUT` (no tab
refactor), react to 409 by refetching and showing one banner "Proyek baru diubah asisten — dimuat
ulang"; the page refetches after each assistant turn.

9.4 **Scenes and locations single-sourced the same way.** On bible boards one model function
(`syncBible`) writes both sides: location edits set `bible.locations[K].lookdev` and
`board.locations[K].look`; scene edits set title/location on both and the goal on the bible card.
`add_scene` requires a goal and creates the bible scene card, so its shots compile.

9.5 **Legacy (no-bible) boards.** Structure actions work (add/move/remove scene and shot, narration,
framing, move, render, assemble). Content edits on a legacy shot rewrite only that shot's prose prompt
and pass the existing storyboard validator; only that shot re-renders. The assistant never upgrades a
legacy board to a bible on its own (that recompiles every shot and invalidates every paid clip); the
Bible tab's "Buat bible" stays the explicit, warned path.

9.6 **Attachments are action inputs, not vision.** The text models get a text line per attachment
("lampiran 1: gambar 1024×1536"). Attachments and project media pointers ("keyframe shot 2", "sheet
Laras") resolve to media ids that actions accept: `edit_character {reference}`, `redraw_frame
{reference}` and `add_shot {startFrame}`. They take effect with OpenRouter engines; with Flow the
reply says the reference is stored and Flow uses the generated sheet.

9.7 **MCP edits are visible and undoable.** Each mutating MCP call is its own entry in the project's
assistant history, labelled "MCP · <token name>", with the same Batalkan chip. MCP also gets
`undo_last`.

9.8 **Uploaded reference adds, never silently re-draws.** An upload is attached to that character's
sheet job (OpenRouter image input) alongside the text; affected keyframes are marked "referensi
berubah" with one action "Gambar ulang keyframe <nama>" (free on Flow). On `cepat` boards the
reference is sent with OpenRouter clips only.

9.9 Code names: the service method is `updateStoryboard`; on bible boards `shot.prompt` is rebuilt
from the intent on every intent edit so TOKEN-based cast detection keeps working.

## 10. Left to the builder

Exact component split inside each feature folder, copy of example chips, rate-limit numbers, snapshot
file format, MCP tool names beyond the table, how attachments are thumbnailed.

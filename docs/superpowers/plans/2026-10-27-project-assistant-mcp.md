# Project Assistant, Scene-to-Shot AI and MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude/ChatGPT-style assistant on every project (text + image upload) that edits and generates through one bible-safe action layer, the same layer exposed over MCP, plus AI scene→shot breakdown, intent-based shot editing, single-source characters/locations, `@ # /` autocomplete and character reference cards.

**Architecture:** `server/src/llm` talks to OpenCode Go. `server/src/assistant/actions.ts` is the only code that mutates a project on behalf of a model; it sits on `StoryService` (revision-checked, snapshotted). The chat endpoint (SSE) and the MCP server are thin adapters over the actions. Web gets a right-hand assistant column and smaller fixes in the existing project tabs.

**Tech Stack:** Fastify 5 + TS (server), React 19 + base-ui + Tailwind v4 (web), vitest, `@modelcontextprotocol/sdk@^1.30.1`, `react-markdown` + `remark-gfm` (new, web).

**Spec:** `docs/superpowers/specs/2026-10-27-project-assistant-mcp-design.md` (read §6 and §9 before any task).

## Global Constraints

- Work only in worktree `.worktrees/project-assistant`, branch `feat/project-assistant`. Never touch the main checkout (another worker owns the uncommitted Axcel files there). Keep edits to shared files (`server/src/app.ts`, `server/src/providers/*`, `web/src/features/settings/ProviderPanel.tsx`, `SettingsPage.tsx`) to small additive hunks — they will be merged with that worker's changes.
- Tests: `env -u PYTHONPATH STORY_PYTHON=/usr/bin/python3 npx vitest run [path]`; typecheck `npx tsc -p server/tsconfig.json --noEmit` and `npx tsc -p web/tsconfig.json --noEmit`. TDD: test RED for the right reason → implement → GREEN → one sabotage of the key line (python string replace, `timeout 150`, restore verified by `git diff --quiet`).
- UI: Indonesian copy (English only for prompt/look fields), no native `<select>`/date/radio/checkbox (use `web/src/ui/controls.tsx`), every field has a placeholder, three states (skeleton, empty-with-action, error via `describeError` + Coba lagi), bounded media, `max-w` and spacing consistent with the project page.
- Secrets: OpenCode key at `<data>/providers/opencode-go.json`, MCP tokens at `<data>/mcp/tokens.json`, both via `writePrivateJsonFile` (0600); APIs return `keyHint` (last 4) only; never log keys/tokens.
- Admin-only: every new route and MCP token follows `requireAdmin` like the story routes.
- Text model chain: `glm-5.3` → `glm-5.3-flash` → `beam-free`; base `https://opencode.ai/zen/go/v1`; header `x-opencode-session: ses_<12 hex><14 alnum>` per request; normal `User-Agent`; 60 s per call.
- Spending (Flow credits / OpenRouter $) never happens without `confirm`; edits never re-queue a paid clip whose effective prompt is unchanged (existing promptHash rule).

## Review Focus

- A model names a shot/scene number that does not exist → plain error listing valid numbers, nothing changed (Task 3).
- A tab saves a stale board after the assistant changed it → 409 `STALE`, tab refetches, assistant change kept (Tasks 2, 6).
- OpenCode Go returns 429/5xx/timeout on glm-5.3 → falls through to glm-5.3-flash then beam-free; all fail → one Indonesian error turn, history intact (Tasks 1, 4).
- Uploading a non-image or a >10 MB file in chat → rejected client- and server-side with a plain message (Tasks 4, 7).
- Undo after a later manual edit → refused with the spec's message, board untouched (Tasks 2, 3).

---

### Task 1: OpenCode Go client + text-model settings

**Files:**
- Create: `server/src/llm/opencode.ts`, `server/src/llm/config.ts`, `server/test/llm-opencode.test.ts`, `web/src/features/settings/TextModelPanel.tsx`, `web/src/features/settings/TextModelPanel.test.tsx`
- Modify: `server/src/providers/routes.ts` (add 3 routes), `server/src/app.ts` (construct store + client, pass to later tasks via `options`), `web/src/features/settings/ProviderPanel.tsx` (mount `<TextModelPanel/>` — one line), `web/src/features/settings/settingsClient.ts`

**Interfaces — Produces:**
- `type ChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }`
- `type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }`
- `type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: object } }`
- `interface TextModel { chat(input: { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; signal?: AbortSignal }): Promise<{ message: ChatMessage; model: string; usage?: { total_tokens?: number } }>; configured(): Promise<boolean> }`
- `createOpenCodeModel(deps: { store: TextModelConfigStore; fetch: FetchLike; models?: string[]; timeoutMs?: number }): TextModel`
- `class TextModelConfigStore(dataDir)` with `view(): Promise<{ configured: boolean; keyHint?: string; model: string }>`, `patch({ apiKey?: string|null; model?: string })`, `key(): Promise<string|undefined>`; `TEXT_MODELS = ['glm-5.3','glm-5.3-flash','beam-free','deepseek-v4-pro']`
- Routes: `GET /api/providers/text` → view; `PUT /api/providers/text` {apiKey?, model?} → view; `POST /api/providers/text/test` → `{ ok: true, model, ms }` or 502 with plain message.
- `textToolAdapter(model: TextModel): TextGenerator` (system, prompt → string) so the draft path can use it.

- [ ] **Step 1: Write failing tests** (`llm-opencode.test.ts`, fake fetch): sends `Authorization: Bearer k`, a UA, and `x-opencode-session` matching `/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/`, a new value per call; posts to `https://opencode.ai/zen/go/v1/chat/completions` with `model:'glm-5.3'`; on 429 for glm-5.3 retries with `glm-5.3-flash`, then `beam-free`; all fail → throws `LlmError` with code `UNAVAILABLE`; no key → `configured()` false and `chat` throws `NOT_CONFIGURED` without calling fetch; config file mode is 0600 and `view()` never contains the key. Route tests: member 403, admin PUT stores, GET shows `keyHint` last 4, `test` returns ok with fake model.
- [ ] **Step 2:** run, expect FAIL (module not found).
- [ ] **Step 3:** implement as interfaced; chosen model first, then the rest of the chain without duplicates.
- [ ] **Step 4:** `TextModelPanel`: key field (password type, placeholder `sk-…`, write-only, shows "Tersimpan · …abcd"), `Choice` "Model" over `TEXT_MODELS` with hints ("andal untuk aksi", "cepat", "gratis", "alternatif"), button "Tes" showing ms or error. Tests: no native select, placeholder present, save calls PUT without echoing key, test shows result.
- [ ] **Step 5:** GREEN + both typechecks; sabotage the fallback loop (e.g. stop after first model) → a test fails; restore.
- [ ] **Step 6:** commit `llm: OpenCode Go client (glm-5.3 chain) + Model teks settings`.

### Task 2: Revisions, snapshots, bible sync, intent→prompt

**Files:**
- Create: `server/src/stories/snapshots.ts`, `server/src/bible/sync.ts`, `server/test/story-revision.test.ts`, `server/test/bible-sync.test.ts`
- Modify: `server/src/stories/service.ts` (`rev` in record, `updateStoryboard(id, board, { rev? })`, snapshot hooks), `server/src/stories/storyboard.ts` (export `promptFromIntent`), `server/src/stories/routes.ts` (PUT reads `rev`, 409 STALE; new `POST /api/stories/:id/compile-shot`)

**Interfaces — Produces:**
- `StoryRecord.rev: number` (starts 1, +1 on every storyboard change).
- `StoryService.updateStoryboard(id, board, opts?: { rev?: number }): Promise<StoryRecord>` → throws `StoryError('STALE')` when `opts.rev` given and ≠ current.
- `SnapshotStore(dir)` with `take(storyId, label): Promise<{ undoId: string; revAfter?: number }>`, `commit(undoId, revAfter)`, `restore(storyId, undoId, currentRev): Promise<'ok'|'stale'|'missing'>` — snapshot = storyboard.json + `story.shots`/`cast` take state; ring 50.
- `syncBible(board): Board` — characters/locations/scenes per spec §9.1/§9.4 (freeze `look` unless anchors changed vs previous board: `syncBible(next, prev?)`).
- `promptFromIntent(board, shot): string` — `"<Framing> shot, the camera <move>. <TOKEN> <action>."` used to keep `shot.prompt` TOKEN-aware.
- `POST /api/stories/:id/compile-shot` {shot} → `{ imagePrompt, videoPrompt, issues: string[] }` (no save).

- [ ] **Step 1: failing tests**: PUT with old `rev` → 409 `{error:{code:'STALE'}}` and board unchanged; restore after an edit that re-queued a paid clip brings `status:'done'`, same `jobId`/`promptHash`, byte-identical storyboard; restore when rev moved on → `'stale'`; ring keeps 50; `syncBible` keeps `look` when only want/need changed, rebuilds it when anchors changed, writes location `lookdev` and `look`, `add_scene` without goal rejected; `compile-shot` returns lint-clean prompts for a drafted shot and `issues` for an empty intent.
- [ ] **Step 2:** RED. **Step 3:** implement; `updateStoryboard` calls `syncBible(next, prev)` only for boards with a bible; rebuild `shot.prompt` via `promptFromIntent` when the intent changed.
- [ ] **Step 4:** GREEN, full server suite (legacy hash tests must stay green), sabotage the rev check → test fails; restore.
- [ ] **Step 5:** commit `stories: revisions + undo snapshots + bible single source`.

### Task 3: Action layer (+ scene breakdown, sheets, references)

**Files:**
- Create: `server/src/assistant/actions.ts`, `server/src/assistant/resolve.ts`, `server/src/assistant/breakdown.ts`, `server/src/assistant/uploads.ts`, `server/test/assistant-actions.test.ts`, `server/test/assistant-breakdown.test.ts`
- Modify: `server/src/stories/service.ts` (`makeSheet(id, token)`, references on cast), `server/src/stories/routes.ts` (`POST /api/stories/:id/scenes/:sceneId/breakdown`, `POST /api/stories/:id/cast/:token/sheet`, `POST /api/stories/:id/uploads` multipart ≤10 MB png/jpg/webp, `GET …/uploads/:file`), OpenRouter worker (attach `job.references` as image inputs)

**Interfaces — Consumes:** Task 1 `TextModel`; Task 2 `updateStoryboard(...,{rev})`, `SnapshotStore`, `syncBible`, `promptFromIntent`.
**Produces:**
- `type ActionContext = { stories: StoryService; snapshots: SnapshotStore; model?: TextModel; userId: string; source: 'chat'|'mcp'|'ui'; turn: { undoId?: string } }`
- `type ActionResult = { ok: true; label: string; changed?: boolean; data?: unknown } | { ok: false; error: string } | { ok: false; needsConfirm: true; label: string; estimate: { credits?: number; usd?: number } }`
- `ACTIONS: Record<ActionName, { description: string; schema: object /* JSON schema */; spends: boolean; run(ctx, storyId, input): Promise<ActionResult> }>` with names exactly: `get_project, edit_shot, add_shot, remove_shot, move_shot, breakdown_scene, edit_scene, add_scene, remove_scene, edit_character, add_character, edit_location, add_location, set_look, make_sheet, redraw_frame, prepare, render, assemble, undo_last`.
- `toolSpecs(): ToolSpec[]` (for Task 4/5).
- `resolveShot(board, ref: number|string) / resolveScene(...)` → id or error listing valid numbers ("Shot yang ada: 1–10").
- `breakdownScene(model, board, sceneId, count 2..8, brief?) → Shot[]` compiled-and-linted, one feedback retry.

- [ ] **Step 1: failing tests**: each mutating action snapshots once per turn and bumps rev; `edit_shot {shot: 3, action}` on a bible board edits intent, rebuilds prompt, never touches another story id; on a legacy board edits only that shot's prose and passes `validateStoryboard`; `render` without confirm → `needsConfirm` with credits estimate and no job queued, with confirm → job queued; unknown shot 99 → error text contains "1–"; `breakdown_scene` with fake model returning 3 intents inserts 3 compiled shots in that scene, an invalid intent gets one feedback retry then plain error with nothing inserted; `make_sheet` queues one image job for that token only (0 credits on Flow); upload rejects `text/plain` and 11 MB; `undo_last` restores.
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** GREEN; sabotage the confirm gate → test fails; restore. **Step 5:** commit `assistant: action layer, scene breakdown, sheets, references`.

### Task 4: Assistant endpoint (SSE), history, skills pack

**Files:**
- Create: `server/src/assistant/chat.ts`, `server/src/assistant/history.ts`, `server/src/assistant/skills/{cinematic,continuity,copy,hooks}.md`, `server/src/assistant/skills.ts`, `server/test/assistant-chat.test.ts`
- Modify: `server/src/stories/routes.ts` or new `server/src/assistant/routes.ts` registered in `app.ts`

**Interfaces — Consumes:** Tasks 1, 3. **Produces:**
- `POST /api/stories/:id/assistant` body `{ message: string; attachments?: string[] /* upload ids */; confirm?: string /* pending id */; rev?: number }` → `text/event-stream` events: `turn {id}`, `step {label}` (e.g. "Mengubah shot 3"), `delta {text}`, `change {label, undoId}`, `pending {id, label, estimate}`, `error {message}`, `done {rev}`.
- `GET /api/stories/:id/assistant` → `{ turns: Turn[] }`; `Turn = { id, at, role: 'user'|'assistant', text, attachments?: {id,url,w,h}[], changes?: {label,undoId,undone?}[], pending?: {...}[], source?: 'chat'|'mcp', by?: string }` (last 50).
- `POST /api/stories/:id/assistant/undo/:undoId` → `{ ok, rev }` or 409 with spec message.
- `skillsPrompt(): string` — the four skill files concatenated (≤ 2,500 words total) + `listSkills()` for MCP.

Skill files are condensed, imperative rules distilled from the project's own cinematic-quality notes, the shooting and copy craft references, and `server/src/text/lint.ts` (P4 banned list). They must say: edit intent not prompt text; one action and one camera move per shot; keep character anchors verbatim; narration ≤12 words, Indonesian, no empty adjectives; hook in the first shot.

System prompt = role + project summary (`get_project`) + `skillsPrompt()` + rules (address shots by the numbers shown, ask before spending, answer in Indonesian, short).

- [ ] **Step 1: failing tests** (fake TextModel scripted with tool calls): message "ubah emosi shot 2 jadi lega" streams `step`, `change`, `done` and history gets user+assistant turns; a spending call yields `pending` and no job until a second POST with `confirm` id; tool loop stops at 6 steps; all models failing → `error` event and history keeps the user turn; unknown attachment id → 400; undo endpoint restores and marks `undone`; system prompt contains the skills text and the project's real shot count.
- [ ] **Step 2–4:** RED → implement → GREEN; sabotage the 6-step cap → test fails; restore. **Step 5:** commit `assistant: SSE chat, history, undo, skills pack`.

### Task 5: MCP server + personal tokens

**Files:**
- Create: `server/src/mcp/server.ts`, `server/src/mcp/tokens.ts`, `server/src/mcp/routes.ts`, `server/test/mcp.test.ts`
- Modify: `server/package.json`/root `package.json` (add `@modelcontextprotocol/sdk@^1.30.1`), `server/src/app.ts` (register)

**Interfaces — Consumes:** Task 3 `ACTIONS`, Task 4 `history` (log MCP entries), `listSkills`. **Produces:**
- `/mcp` Streamable HTTP (stateless) with tools = `list_projects`, `create_project` {premise, template?, aspect?}, plus every `ACTIONS` entry with an added required `project_id` and optional `confirm: boolean` on spending tools; resources `nirmalab://skills/<name>`.
- Token routes (admin): `GET /api/mcp/tokens` → `[{id,name,createdAt,lastUsedAt}]`, `POST /api/mcp/tokens` {name} → `{id,name,token}` (token `nc_` + 32 random base62, returned once), `DELETE /api/mcp/tokens/:id`, `POST /api/mcp/test` (session-auth) → runs tools/list in-process → `{ ok, tools: n }`.
- Stored `{id,userId,name,sha256,createdAt,lastUsedAt}`; reject revoked, unknown, or token of a removed/non-admin user (401 JSON-RPC error).

- [ ] **Step 1: failing tests** using the SDK `Client` + `StreamableHTTPClientTransport` against `app.listen(0)`: no token → 401; valid token → `tools/list` includes `edit_shot` and `list_projects`; `edit_shot` changes the story and adds a history turn `source:'mcp'` labelled with the token name; `render` without `confirm` returns `needsConfirm` and queues nothing; revoked token → 401; token file mode 0600 and contains no plaintext token.
- [ ] **Step 2–4:** RED → implement → GREEN; sabotage the hash comparison → test fails; restore. **Step 5:** commit `mcp: remote MCP server + personal tokens`.

### Task 6: Project tabs — intent shot sheet, character/location cards, scene breakdown, MentionTextarea, STALE

**Files:**
- Create: `web/src/ui/MentionTextarea.tsx`, `web/src/ui/MentionTextarea.test.tsx`, `web/src/features/project/IntentFields.tsx`, `web/src/features/project/CharacterCard.tsx`, tests beside them
- Modify: `ShotSheet.tsx`, `BreakdownTab.tsx`, `BibleTab.tsx` (remove character editor → link to Breakdown), `SceneBoard.tsx` ("Pecah jadi shot" dialog: jumlah 2–8 + arahan opsional), `useProject.tsx` (send `rev`, handle 409 STALE → refetch + banner), `storiesClient.ts`

**Interfaces — Consumes:** Task 2 `rev`, `compile-shot`; Task 3 breakdown/sheet/upload routes. **Produces:**
- `<MentionTextarea value onChange triggers={{ '@': Item[], '#': Item[], '/': Item[] }} placeholder … />` where `Item = { id: string; label: string; hint?: string; avatar?: string; insert: string }`; ArrowUp/Down/Enter/Tab/Escape; mouse select; inserts `item.insert` + space; exposes `role=combobox`/`listbox`.

- [ ] **Step 1: failing tests**: typing `@La` lists Laras and Enter inserts `LARAS `; Escape closes; bible shot sheet shows fields Subjek/Aksi/Keadaan awal/Keadaan akhir/Emosi/Narasi and a read-only "Prompt yang dikirim" from `compile-shot`; legacy shot sheet still shows the prompt textarea; character card shows sheet image when done, "Buat sheet" calls the sheet route, "Unggah referensi" posts multipart and rejects a 11 MB file client-side, anchor edit shows the re-render warning with counts before saving; "Pecah jadi shot" posts `{count:3, brief}` and refreshes; a 409 STALE on save shows "Proyek baru diubah asisten — dimuat ulang" once and refetches; no native controls on the touched pages; every new field has a placeholder.
- [ ] **Step 2–4:** RED → implement → GREEN; sabotage the STALE handler → test fails; restore. **Step 5:** commit `project: intent shot sheet, character cards, scene breakdown, mentions`.

### Task 7: Assistant panel (Claude/ChatGPT style)

**Files:**
- Create: `web/src/features/assistant/{AssistantPanel.tsx, MessageList.tsx, Composer.tsx, ChangeChips.tsx, PendingCard.tsx, assistantClient.ts, sse.ts}` + tests
- Modify: `web/src/features/project/ProjectPage.tsx` (two columns at `lg+`, collapsible right column 360–400 px remembered in localStorage guarded; below `lg` a header button "Asisten" opens a `Sheet`), root `package.json` (`react-markdown`, `remark-gfm`)

**Interfaces — Consumes:** Task 4 endpoints/events; Task 6 `MentionTextarea`. **Produces:** `<AssistantPanel story board onChanged={() => reload()} />`.

Look: Claude/ChatGPT — user messages right-aligned in a soft bubble, assistant messages full-width plain text with markdown (lists, bold, code), a small avatar mark, a thin "step" line with spinner while tools run ("Mengubah shot 3…"), change chips under the message (label + **Batalkan**, greyed "Dibatalkan" after), pending card with cost and **Jalankan**/**Lewati**, image attachments as 64-px rounded thumbnails (in composer: removable chips before send; in history: clickable to a bounded preview). Composer: auto-growing `MentionTextarea` (1–8 lines), paperclip button (image only, ≤10 MB, multiple up to 4, paste and drag-drop supported), Enter sends / Shift+Enter newline, Stop while streaming. Empty state: one line + three suggestion chips built from the real project ("Pecah scene 1 jadi 4 shot", "Di shot 2, buat Laras lebih lega", "Buat sheet untuk <first character>"). Not configured: one line "Asisten butuh model teks — atur di Pengaturan › Provider" with link; the rest of the page works.

- [ ] **Step 1: failing tests** (fake fetch streaming SSE text): sending shows the user bubble immediately, step line, streamed text, a change chip; clicking Batalkan posts undo and shows "Dibatalkan"; pending card Jalankan posts `confirm`; attach a png shows a thumbnail and the POST includes its upload id; a `.txt` or 11 MB file is refused with a message; Enter sends, Shift+Enter adds a newline; Stop aborts; `@` suggests characters; markdown list renders `<li>`; not-configured state shows the link; history loads on mount; `onChanged` is called after `done`.
- [ ] **Step 2–4:** RED → implement → GREEN; sabotage `onChanged` call → test fails; restore. **Step 5:** commit `assistant: chat panel`.

### Task 8: Settings › Integrasi + Studio/Template one-liners

**Files:**
- Create: `web/src/features/settings/IntegrationsPanel.tsx`, `web/src/features/settings/mcpSnippets.ts` (+ tests)
- Modify: `SettingsPage.tsx`/`SettingsDialog.tsx` (tab `integrasi`, title "Integrasi"), Template and Studio page headers (one line each)

**Produces:** `snippetFor(client: 'claude-code'|'claude-desktop'|'cursor'|'opencode'|'codex', url: string): { file?: string; language: 'bash'|'json'|'toml'; text: string; steps: string[] }` — text uses the literal placeholder `<TOKEN>`; the implementer must verify each format against the client's current official docs (web search) and cite the doc URL in a comment.

UI: token list (nama, dibuat, terakhir dipakai, Cabut with AlertDialog), "Buat token" (name field with placeholder, then a one-time reveal box with Salin and "Token ini hanya ditampilkan sekali"), a `Segmented` client picker, numbered steps + code block with Salin, "Tes koneksi" (calls `/api/mcp/test`).

- [ ] **Step 1: failing tests**: snippets contain the URL and `<TOKEN>`, never a real token; create shows the token once and hides it after closing; revoke calls DELETE after confirm; test button shows "Terhubung · N tools"; no native controls; placeholders present; Template header says it starts a project, Studio header says one clip or still without a project.
- [ ] **Step 2–4:** RED → implement → GREEN; sabotage the one-time reveal → test fails; restore. **Step 5:** commit `settings: Integrasi (MCP tokens + tutorial)`.

### Task 9: End-to-end, merge, deploy, live verification

- [ ] **Step 1:** Full suite + both typechecks green, `skipped` 0.
- [ ] **Step 2:** Local E2E on a copy of a real bible story and a legacy story (rsync read-only from prod), server on :3997 with the real OpenCode key placed via `PUT /api/providers/text` (read from `~/.local/share/opencode/auth.json` by a script, never printed): chat "pecah scene 2 jadi 3 shot" and "di shot 1 ubah emosinya jadi lega" through the real API; assert storyboard changes, compiled prompts lint-clean, no paid clip re-queued, Batalkan restores byte-identical storyboard + done takes; upload an image and attach it to a character.
- [ ] **Step 3:** MCP with a real client: create a token, `claude mcp add --transport http nirmalab-local http://localhost:3997/mcp --header "Authorization: Bearer $T"` in a throwaway `CLAUDE_CONFIG_DIR`, `claude mcp list` shows connected; SDK script calls `get_project`, `edit_shot`, and `render` without confirm (refused). Remove the config after.
- [ ] **Step 4:** Playwright walk of project page (1440, 390): assistant panel, streaming, chips, attachment, mentions, intent sheet, character card, Integrasi tab; screenshots + vision critique; fix and re-walk (max 3 passes).
- [ ] **Step 5:** Merge: rebase `feat/project-assistant` onto `main` at that moment (the Axcel worker may have committed); resolve conflicts in shared files additively; full suite again.
- [ ] **Step 6:** Deploy (shipping skill procedure), place the OpenCode key on prod via the settings API with a temp admin, live walk + one real assistant turn on a throwaway project, check `docker logs` (no 5xx), delete the throwaway project and temp admin (login → 401), update the shipping skill.

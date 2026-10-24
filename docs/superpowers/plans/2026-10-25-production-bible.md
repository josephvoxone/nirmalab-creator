# P1 — Production Bible & Prompt Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every image and video prompt is compiled deterministically from a versioned visual + story bible, so output is consistent and testable instead of free-text guesses.

**Architecture:** A new pure module `server/src/bible/` holds six look families (with named variants), the story-bible schema and validators, and the prompt compiler. The storyboard gains an optional `bible`; boards without it keep the legacy path (frozen `style` string, `promptVersion: 1`). The draft LLM stops writing prompt text and writes intent instead.

**Tech Stack:** TypeScript (Fastify server), Vitest, React 19 (web), zsh/bash scripts, /usr/bin/python3 for scripted edits.

**Spec:** `docs/superpowers/specs/2026-10-25-production-bible-design.md` (§4, §9)

## Global Constraints

- Prompt text in English; UI copy and narration in Indonesian.
- No new runtime dependency for the compiler; pure functions only, no IO.
- Boards without `bible` must render exactly as today: same `style` string, `promptVersion: 1`, no clip re-render.
- Mandatory compiler slots: `subject`, `oneAction`, `startState`, `endState`, `lens`, `lightDirection`, `≥2 palette anchors`, `setting`, `styleSentence`, `medium`.
- Banned in compiled prompts: empty adjectives without evidence, camera gear words (`crane`, `dolly track`, `rig`), more than one camera move, narration > 12 words, TOKEN instead of a name.
- Six families: `film-real`, `painterly`, `cel-anime`, `clay`, `docu`, `noir`. Variants keep old named styles (`storybook`, `papercut`, `wayang`, `comic`, `pixar-3d`, `lowpoly`, `anime-2d`, `cinematic-drama`).
- Tests: `STORY_PYTHON=/usr/bin/python3 npx vitest run --project server <path>`; typecheck both tsconfigs before commit.
- Sabotage each new guard once (break the line, watch the test go red, restore, verify hash).

## Review Focus

- A legacy board edited after this ships must keep its done clips (hash versioning) — a wrong guess here bills 10 credits per shot.
- A bible with a valid schema but an aesthetic-only anchor ("beautiful woman") must be rejected, not compiled.
- A shot whose action needs two verbs ("opens the door and runs") must be rejected by lint, not silently split.
- A compiled prompt for a `cepat` project (no keyframe) must still pass the same slot rules.
- An `id` collision between a family variant and a legacy style must resolve deterministically.

---

### Task 1: Look families

**Files:** Create `server/src/bible/styles.ts`, `server/src/bible/styles.test.ts`

**Interfaces:**
- Produces: `type LookId`, `type StyleBible { id, version, label, family, variant, medium, stock, lenses, aperture, palette, light, grain, halation, composition, forbidden, styleSentence }`, `LOOKS: StyleBible[]`, `lookById(id: string): StyleBible | undefined`, `compileStyleSentence(look): string`, `LEGACY_STYLE_MAP: Record<string, { family: LookId; variant: string }>`.

- [ ] **Step 1: Write failing tests** — one test per family asserting `styleSentence` equals a snapshot value (18 goldens: 6 families × {still, action, dialogue} come in Task 3; here 8 variant sentences), plus a test that every `LEGACY_STYLE_MAP` key resolves to an existing family+variant.
- [ ] **Step 2: Run** `npx vitest run --project server server/src/bible/styles.test.ts` — expect failure (module missing).
- [ ] **Step 3: Implement** `styles.ts`: six family definitions with stock/lenses/aperture/palette(hex+use)/light/grain/halation/composition/forbidden; variants as `{ id, label, extra: string }`; `compileStyleSentence` builds `"Shot on <stock>, <lenses>, <aperture>, <light.key>, <light.temp>, palette <hexes with roles>, <grain>, <halation>. <medium sentence>. Avoid: <forbidden joined>."` — deterministic, no randomness.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit** `feat(bible): six look families with locked style sentences`.

### Task 2: Story bible schema

**Files:** Create `server/src/bible/story.ts`, `server/src/bible/story.test.ts`

**Interfaces:** `type StoryBible`, `type CharacterCard`, `type SceneCard`, `validateBible(bible): string[]`, `GENERIC_ANCHOR` regex list.

- [ ] **Step 1: Failing tests** — accepts a valid bible; rejects: empty logline; character without `want` or `need`; anchor set that is only generic adjectives (`beautiful`, `megah`, `indah`, `epic`, `cinematic`) with no concrete noun; scene without `goal`; structure not containing `hook` and `payoff`; more than 20 characters.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** `story.ts` with the types from the spec §4.2 and a validator returning Indonesian messages.
- [ ] **Step 4: Run — expect pass.** **Step 5: Commit.**

### Task 3: Prompt compiler

**Files:** Create `server/src/bible/compiler.ts`, `server/src/bible/compiler.test.ts`

**Interfaces:** `type ShotIntent { subject, action, startState, endState, emotion?, setting?, framing, move }`, `compileShot({ look, bible, scene, shot }): { imagePrompt, videoPrompt, negative, audio, warnings }`, `lintPrompt(text): string[]`.

- [ ] **Step 1: Failing tests** — 18 goldens (6 families × still / action / dialogue) asserting the exact compiled string; rejection cases: action with "and then", two camera moves, missing `endState`, narration 13 words, TOKEN in narration, gear word, empty lens.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** segment order from spec §4.3; expand TOKEN→name from the bible; negative = look.forbidden + board.negative merged without duplicates; audio line = narration with names spoken.
- [ ] **Step 4: Run — expect pass.** **Step 5: Commit.**

### Task 4: Storyboard + service integration (legacy safe)

**Files:** Modify `server/src/stories/storyboard.ts` (optional `bible`, `promptVersion` in hashes, `compileBoardShot`), `server/src/stories/service.ts` (hash input includes version), tests `server/test/bible-integration.test.ts`.

**Interfaces:** `Storyboard.bible?: StoryBible`; `PROMPT_VERSION = 2`; `hashFor(board, shot)` returns legacy hash when `!board.bible`.

- [ ] **Step 1: Failing tests** — a board with `bible` compiles prompts from the compiler; a legacy board produces byte-identical prompts and hashes to today (fixture captured before the change); editing a legacy board keeps `status: done` and every `jobId`; a board with an invalid bible is rejected with 400.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** narrow patches; no change to `collect()`.
- [ ] **Step 4: Run the whole server suite — 365+ pass.** **Step 5: Commit.**

### Task 5: Draft writes intent, not prose

**Files:** Modify `server/src/stories/draft.ts`, `server/test/story-draft.test.ts` (add cases).

- [ ] **Step 1: Failing tests** — draft of a premise returns `bible` (logline, structure with hook+payoff, characters with want/need/anchors) and shots carrying `intent {subject, action, startState, endState, emotion}`; legacy model output without intent still produces a valid board (fallback: derive intent from the prose sentence).
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** new SYSTEM prompt (intent schema), lenient normalisation, keep `proseFix`.
- [ ] **Step 4: Run — expect pass; existing draft tests stay green.** **Step 5: Commit.**

### Task 6: Web — Bible tab and family/variant picker

**Files:** Create `web/src/features/project/BibleTab.tsx` (+ test), `web/src/features/bible/looks.ts` mirror; modify `ProjectPage.tsx` (tab), `features/studio/*` and `features/home/*` pickers to family+variant, `storiesClient.ts` types.

- [ ] **Step 1: Failing tests** — Bible tab shows logline/theme/structure/characters/scenes with validation messages from the server; editing an anchor saves the board; the picker lists 6 families and their variants; a board without `bible` shows a "Buat bible" action instead of an empty editor.
- [ ] **Step 2: Run — expect fail.** **Step 3: Implement.** **Step 4: Pass.** **Step 5: Commit.**

### Task 7: Templates remapped to family + variant

**Files:** Modify `server/src/stories/looks.ts` (each of the 33 templates gains `family` + `variant`, `look` object derived), `server/test/looks.test.ts`.

- [ ] **Step 1: Failing tests** — every template maps to an existing family+variant; `wayang`, `comic`, `papercut`, `lowpoly` survive as variants; the catalog exposes `families` with `variants`.
- [ ] **Step 2: Run — expect fail.** **Step 3: Implement remap table.** **Step 4: Pass.** **Step 5: Commit.**

### Task 8: Local end-to-end and deploy

- [ ] Build, run the local server on a copy of a real story, walk: create project from a template, check compiled prompts in the Bible tab, confirm legacy story renders without re-queueing clips, 390 px check.
- [ ] Full suite + typecheck, commit, deploy, live smoke, remove QA user.

## Self-review

Spec §4.1→Task 1, §4.2→Task 2, §4.3→Task 3, §9.1/§9.2→Task 4, §9.6→Task 5, UI §4.6→Task 6, template remap §7 P1→Task 7. Audit (§4.4) and trends (§4.5) are P2/P3 and out of scope here. Type names match across tasks (`StyleBible`, `StoryBible`, `ShotIntent`, `compileShot`, `validateBible`, `PROMPT_VERSION`).

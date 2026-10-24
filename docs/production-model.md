# Production model: Proyek → Scene → Shot

A project (story) is produced like a film: a **breakdown** (cast, locations, look) feeds
**scenes** (chapters), each scene holds ordered **shots**. Every scene can be keyframed,
rendered and previewed on its own; the final video is assembled from all shots in order.
Order of scenes and shots is edited by drag-and-drop on the timeline.

## Storyboard (storyboard.json) — additions, all optional and backward compatible

```ts
type Location = { name: string; look: string };          // look: English visual descriptor of the place
type Scene = {
  id: string;            // /^[a-z0-9][a-z0-9-]{0,40}$/, unique
  title: string;         // Indonesian, 1..80 chars
  summary?: string;      // Indonesian, what happens (<= 300 chars)
  location?: string;     // key in `locations`
  shots: string[];       // shot ids in play order
};
Storyboard.logline?: string;                      // one Indonesian sentence
Storyboard.locations?: Record<string, Location>;  // key: UPPERCASE token, e.g. "PASAR_IKAN"
Storyboard.scenes?: Scene[];
```

### Invariants — `normalizeScenes(board)` (server: storyboard.ts; web: features/project/model.ts; same rules)
1. No/empty `scenes` → one scene `{ id: 'scene-1', title: 'Scene 1', shots: <all shot ids> }`.
2. Unknown shot ids are dropped from scenes; a shot listed twice keeps its first place.
3. Shots not listed in any scene are appended to the last scene.
4. Empty scenes are allowed (a new chapter before shots are dragged in).
5. `board.shots` is reordered to the scene order (scene 1 shots, then scene 2 …).
6. A scene `location` that is not a key of `locations` is dropped.

### Validation (server, on create/update) in addition to the existing shot rules
- ≤ 20 scenes, unique valid ids, non-empty title ≤ 80, summary ≤ 300.
- locations: ≤ 20, key `/^[A-Z][A-Z0-9_]{1,30}$/`, name and look non-empty.

### Prompts
If a shot's scene has a location, `framePrompt` and `buildShotPrompt` add `Setting: <location.look>.`
right after the shot body (before the Style line). Changing a location therefore invalidates the
keyframes/clips of the scenes that use it (prompt hash changes), and nothing else.

## StoryRecord additions
- `videoStale?: boolean` — a final video exists but the storyboard changed after it (order or content).
  Set by `updateStoryboard` when `record.video` exists; cleared after a successful assembly.

### Idle status after an edit or a partial run (replaces "always draft")
`idleStatus(record)`: all shots done and `video` exists and not `videoStale` → `done`;
else konsisten and every frame done → `review`; else `draft`.

## API
| Method | Path | Body | Effect |
|---|---|---|---|
| GET | /api/stories/:id | – | `{ story, storyboard }` — storyboard normalised (scenes always present) |
| PUT | /api/stories/:id | `{ storyboard }` | edit/reorder (existing); keeps done takes whose prompt hash is unchanged |
| POST | /api/stories/:id/prepare | `{ scene?: string }` | cast sheets needed (for that scene, or all) + keyframes for that scene (or all) |
| POST | /api/stories/:id/render | `{ force?: boolean, scene?: string, shot?: string }` | queue clips for that shot / scene / everything not done |
| POST | /api/stories/:id/assemble | – | rebuild final.mp4 from the current order; 409 INVALID unless every shot is done |

Partial runs: while a scene renders the story is `rendering`/`framing`; when nothing of the run is
still queued it returns to `idleStatus` (or `failed` if a take of the run failed after 3 tries), and
assembles automatically only when every shot of the story is done.

Budget for render = shots in the run × 10 credits (BUDGET unless `force`).

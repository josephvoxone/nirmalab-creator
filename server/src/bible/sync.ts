/**
 * Bible single source (spec §9.1, §9.4, §9.9). Bible boards hold two copies of the same facts and
 * the compiler reads only one of them:
 *
 * - characters: `board.characters[T].look` feeds the character sheet hash; `bible.characters[T].anchors`
 *   feed the shot prompts. `look` stays frozen (it is what the paid sheet was built from) and is
 *   rebuilt from `name, anchors` only when that character's anchors change.
 * - locations: `board.locations[K].look` ↔ `bible.locations[K].lookdev`, mirrored from the side that
 *   changed; the bible wins when both did.
 * - scenes: title/location mirrored between `board.scenes` and the bible card with the same id;
 *   the goal lives on the card.
 *
 * Only what this edit changed (vs `prev`) is mirrored, so a save never rewrites facts nobody
 * touched — an old divergence stays as it is instead of re-rendering clips on the next save.
 * Legacy boards (no bible) are returned untouched. Pure: no IO, inputs are not mutated.
 */
import type { CharacterSpec, Location, Scene, Shot, Storyboard } from '../stories/storyboard.js';
import { promptFromIntent, titleCase } from '../stories/storyboard.js';
import type { BibleLocation, CharacterCard, SceneCard } from './story.js';

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const anchorsOf = (c: CharacterCard | undefined) => (Array.isArray(c?.anchors) ? c!.anchors : []).map(a => String(a).trim()).filter(Boolean);
const lookdevOf = (l: BibleLocation | undefined) => (typeof l?.lookdev === 'string' ? l.lookdev.trim() : '');

/** Same format the draft uses when it mirrors bible characters into the cast map. */
export const lookFromAnchors = (card: CharacterCard) => `${card.name.trim()}, ${anchorsOf(card).join(', ')}`;

function withLook(spec: CharacterSpec, look: string): CharacterSpec {
  return typeof spec === 'string' ? look : { ...spec, look };
}

/**
 * Carry the card's name into its cast entry. A name equal to titleCase(TOKEN) keeps a plain look
 * string (the format existing boards have, so no hash moves); any other name becomes `{ name, look }`,
 * because the cast name is what Flow picks the character by and what prompts say.
 */
function named(card: CharacterCard, spec: CharacterSpec): CharacterSpec {
  const name = card.name.trim();
  if (typeof spec === 'string') return name === titleCase(card.token) ? spec : { name, look: spec };
  return { ...spec, name };
}

function syncCharacters(board: Storyboard, prev: Storyboard | undefined): void {
  const bible = board.bible!;
  const cards = Array.isArray(bible.characters) ? bible.characters : [];
  const prevCards = new Map((prev?.bible?.characters ?? []).map(c => [c.token, c]));
  const prevBoard = prev?.characters ?? {};
  const hadSpec = (token: string) => Object.prototype.hasOwnProperty.call(prevBoard, token);
  const characters: Record<string, CharacterSpec> = { ...(board.characters ?? {}) };
  const dropped = new Set<string>();
  for (const card of cards) {
    const before = prevCards.get(card.token);
    const spec = characters[card.token];
    if (spec === undefined) {
      if (before && hadSpec(card.token)) dropped.add(card.token); // removed on the board side
      // A new card, or one that predates the cast sync (never had a board entry): sheets + TOKENs need it.
      else characters[card.token] = named(card, lookFromAnchors(card));
      continue;
    }
    if (before && !same(anchorsOf(before), anchorsOf(card))) characters[card.token] = named(card, withLook(spec, lookFromAnchors(card)));
    else if (before && before.name?.trim() !== card.name?.trim()) characters[card.token] = named(card, spec); // look (sheet) frozen
  }
  // A card removed from the bible in this edit takes its cast entry with it.
  const tokens = new Set(cards.map(c => c.token));
  for (const token of Object.keys(characters)) if (prevCards.has(token) && !tokens.has(token)) delete characters[token];
  bible.characters = cards.filter(c => !dropped.has(c.token));
  board.characters = characters;
}

function syncLocations(board: Storyboard, prev: Storyboard | undefined): void {
  const bible = board.bible!;
  const cards = Array.isArray(bible.locations) ? bible.locations : [];
  const locations: Record<string, Location> = { ...(board.locations ?? {}) };
  const prevBoard = prev?.locations ?? {};
  const prevCards = new Map((prev?.bible?.locations ?? []).map(l => [l.key, l]));
  const hasPrevBoard = (key: string) => Object.prototype.hasOwnProperty.call(prevBoard, key);
  const out: BibleLocation[] = [];
  for (const card of cards) {
    const loc = locations[card.key];
    const before = prevCards.get(card.key);
    if (!loc) {
      // Removed on the board side → removed from the bible; new on the bible side → added to the board.
      if (hasPrevBoard(card.key) && before) continue;
      if (!before) locations[card.key] = { name: card.name, look: lookdevOf(card) || card.name };
      out.push(card);
      continue;
    }
    const bibleChanged = !before || before.name !== card.name || lookdevOf(before) !== lookdevOf(card);
    const boardChanged = !hasPrevBoard(card.key) || prevBoard[card.key]!.name !== loc.name || prevBoard[card.key]!.look !== loc.look;
    if (bibleChanged) {
      // Bible wins; an empty lookdev is "not written yet", so the board's look fills it.
      const look = lookdevOf(card) || loc.look;
      locations[card.key] = { ...loc, name: card.name || loc.name, look };
      out.push({ ...card, lookdev: look });
    } else if (boardChanged) {
      out.push({ ...card, name: loc.name, ...(loc.look ? { lookdev: loc.look } : {}) });
    } else {
      out.push(card);
    }
  }
  const keys = new Set(cards.map(c => c.key));
  for (const [key, loc] of Object.entries(locations)) {
    if (keys.has(key)) continue;
    if (prevCards.has(key) && hasPrevBoard(key)) { delete locations[key]; continue; } // removed on the bible side
    // New on the board side (or the bible is new): the bible gets the card.
    if (!hasPrevBoard(key) || !prev?.bible) out.push({ key, name: loc.name, lookdev: loc.look });
  }
  bible.locations = out;
  board.locations = locations;
  // A bible scene may not point at a location that no longer exists.
  const live = new Set(out.map(l => l.key));
  bible.scenes = (bible.scenes ?? []).map(s => (s.location && !live.has(s.location) ? (({ location: _gone, ...rest }) => rest)(s) : s));
}

function syncScenes(board: Storyboard, prev: Storyboard | undefined): void {
  const bible = board.bible!;
  const prevScenes = new Map((prev?.scenes ?? []).map(s => [s.id, s]));
  const prevCards = new Map((prev?.bible?.scenes ?? []).map(s => [s.id, s]));
  const scenes = Array.isArray(board.scenes) ? board.scenes : [];
  const ids = new Set(scenes.map(s => s.id));
  const boardKeys = new Set(Object.keys(board.locations ?? {}));
  const bibleKeys = new Set((bible.locations ?? []).map(l => l.key));
  const cards = new Map<string, SceneCard>((bible.scenes ?? []).map(c => [c.id, c]));
  const nextScenes: Scene[] = scenes.map(scene => {
    // The same id-or-title match the goal check uses: a card it accepts is a card that is mirrored.
    const found = cardFor(board, scene);
    const card = found && cards.get(found.id);
    if (!card) return scene;
    const was = prevScenes.get(scene.id);
    const wasCard = prevCards.get(card.id);
    const out = { ...scene };
    const outCard = { ...card };
    // Title.
    if (!wasCard || wasCard.title !== card.title) out.title = card.title;
    else if (!was || was.title !== scene.title) outCard.title = scene.title;
    // Location (only to a key the other side knows).
    const cardMoved = !wasCard || wasCard.location !== card.location;
    const sceneMoved = !was || was.location !== scene.location;
    // A new card without a location takes the scene's; otherwise the side that moved wins (bible first).
    const cardWins = cardMoved && (!!wasCard || card.location !== undefined);
    if (cardWins) {
      if (card.location === undefined) delete out.location;
      else if (boardKeys.has(card.location)) out.location = card.location;
    } else if (sceneMoved || !wasCard) {
      if (scene.location === undefined) delete outCard.location;
      else if (bibleKeys.has(scene.location)) outCard.location = scene.location;
    }
    cards.set(card.id, outCard);
    return out;
  });
  // A board scene removed in this edit takes its card with it.
  for (const id of [...cards.keys()]) if (prevScenes.has(id) && !ids.has(id)) cards.delete(id);
  bible.scenes = [...cards.values()];
  board.scenes = nextScenes;
}

/** Effective camera + intent of a shot (the drafter keeps framing/move on the shot). */
const intentKey = (shot: Shot | undefined) => {
  const camera = shot as (Shot & { framing?: string; move?: string }) | undefined;
  return JSON.stringify([shot?.intent ?? null, camera?.framing ?? null, camera?.move ?? null]);
};

/** Rebuild `shot.prompt` from the intent for every intent shot whose intent changed (or is new). */
export function refreshIntentPrompts(board: Storyboard, prev?: Storyboard): Storyboard {
  if (!board.bible) return board;
  const before = new Map((prev?.shots ?? []).map(s => [s.id, s]));
  return {
    ...board,
    shots: board.shots.map(shot => {
      if (!shot.intent || shot.reuse) return shot;
      const was = before.get(shot.id);
      if (was && intentKey(was) === intentKey(shot)) return shot;
      return { ...shot, prompt: promptFromIntent(board, shot) };
    })
  };
}

/** Both sides of a bible board written from one function. `prev` = the board as stored before this edit. */
export function syncBible(next: Storyboard, prev?: Storyboard): Storyboard {
  if (!next.bible) return next;
  const board = clone(next);
  syncCharacters(board, prev);
  syncLocations(board, prev);
  syncScenes(board, prev);
  return refreshIntentPrompts(board, prev);
}

export const cardFor = (board: Storyboard, scene: Scene) => (board.bible?.scenes ?? []).find(c => c.id === scene.id)
  ?? (board.bible?.scenes ?? []).find(c => c.title.trim().toLowerCase() === scene.title.trim().toLowerCase());

/**
 * A scene added in this edit must have its bible card (with the goal), or its shots can never
 * compile — that is how `add_scene` without a goal is rejected. Scenes that already existed are
 * not re-checked, so an older board with a loose scene stays saveable.
 */
export function bibleSceneErrors(board: Storyboard, prev?: Storyboard): string[] {
  if (!board.bible) return [];
  const known = new Set((prev?.scenes ?? []).map(s => s.id));
  return (board.scenes ?? [])
    .filter(scene => !known.has(scene.id) && !cardFor(board, scene)?.goal?.trim())
    .map(scene => `scene ${scene.title}: tujuan (goal) wajib di proyek bible`);
}

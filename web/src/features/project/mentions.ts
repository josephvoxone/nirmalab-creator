/**
 * Who and where a text mentions: the `@`/`#` mention lists of the project (shot sheet, breakdown
 * dialog, chat composer) and the one rule for "this shot uses TOKEN" (Breakdown, character cards).
 */
import { sized } from '../../lib/media.js';
import type { MentionItem, MentionTriggers } from '../../ui/MentionTextarea.js';
import type { Story } from '../stories/storiesClient.js';
import type { Board, Shot } from './model.js';
import { media } from './useProject.js';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** TOKEN as a whole word (letters, digits and _ on either side make it another word). */
export const tokenPattern = (token: string) => new RegExp(`(^|[^A-Za-z0-9_])${token}(?![A-Za-z0-9_])`);

/** A shot uses TOKEN when its prompt or its intent's subject/action names it. */
export function shotUsesToken(shot: Shot, token: string): boolean {
  const re = tokenPattern(token);
  return [shot.prompt, shot.intent?.subject, shot.intent?.action].some(t => typeof t === 'string' && re.test(t));
}

/** The shots that use TOKEN, and the scenes they sit in. */
export function shotsUsing(board: Board, token: string): { shots: Shot[]; scenes: NonNullable<Board['scenes']> } {
  const shots = board.shots.filter(s => shotUsesToken(s, token));
  const scenes = (board.scenes ?? []).filter(sc => sc.shots.some(id => shots.some(s => s.id === id)));
  return { shots, scenes };
}

type CardLike = { token?: unknown; name?: unknown };
/** Bible characters (falling back to the cast map) for `@`, locations for `#`. Shared with the breakdown dialog and the chat composer. */
export function mentionTriggers(projectId: string, board: Board, story?: Story): MentionTriggers {
  const bible = board.bible as { characters?: CardLike[] } | undefined;
  const cards = Array.isArray(bible?.characters) && bible.characters.length
    ? bible.characters.map(c => ({ token: str(c.token), name: str(c.name) || str(c.token) }))
    : Object.entries(board.characters ?? {}).map(([token, spec]) => ({ token, name: typeof spec === 'object' && spec.name ? spec.name : token }));
  const people: MentionItem[] = cards.filter(c => c.token).map(c => {
    const sheet = story?.cast?.find(x => x.token === c.token);
    return {
      id: c.token, label: c.name, hint: c.token, insert: c.token,
      ...(sheet?.status === 'done' ? { avatar: sized(media.cast(projectId, c.token, sheet.mediaId ?? ''), 40) } : {})
    };
  });
  const places: MentionItem[] = Object.entries(board.locations ?? {}).map(([key, l]) => ({ id: key, label: l.name || key, hint: key, insert: key }));
  return { '@': people, '#': places };
}

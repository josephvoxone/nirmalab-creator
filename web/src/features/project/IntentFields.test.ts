import { describe, expect, it } from 'vitest';
import { draftOf, intentFrom, mentionTriggers, missingSlots, sameDraft } from './IntentFields.js';
import { bibleBoard, ID, storyFor } from './testkit.js';
import { BOARD } from './testkit.js';

describe('intent helpers', () => {
  it('reads the intent as form values; camera picks may sit on the shot (drafter shape)', () => {
    const shot = { id: 'x', prompt: 'p', intent: { subject: 'LARAS', action: 'runs', startState: 'a', endState: 'b' }, framing: 'wide', move: 'push-in' };
    expect(draftOf(shot as never)).toEqual({ subject: 'LARAS', action: 'runs', startState: 'a', endState: 'b', emotion: '', framing: 'wide', move: 'push-in' });
    expect(draftOf({ id: 'y', prompt: 'p' })).toEqual({ subject: '', action: '', startState: '', endState: '', emotion: '', framing: '', move: '' });
  });

  it('writes trimmed values, drops empty optionals and keeps fields the form does not edit', () => {
    const out = intentFrom({ subject: ' LARAS ', action: 'runs', startState: 'a', endState: 'b', emotion: '', framing: 'close-up', move: '' }, { subject: 'X', action: 'y', startState: '', endState: '', speaker: 'LARAS', emotion: 'old' });
    expect(out).toEqual({ subject: 'LARAS', action: 'runs', startState: 'a', endState: 'b', framing: 'close-up', speaker: 'LARAS' });
  });

  it('missing slots and equality ignore surrounding spaces', () => {
    const d = { subject: 'A ', action: '', startState: 'x', endState: ' ', emotion: '', framing: '', move: '' };
    expect(missingSlots(d)).toEqual(['action', 'endState']);
    expect(sameDraft(d, { ...d, subject: 'A' })).toBe(true);
  });

  it('@ lists bible characters (sheet avatar when done) and inserts the TOKEN; # lists locations by key', () => {
    const board = bibleBoard();
    const t = mentionTriggers(ID, board, storyFor(board));
    expect(t['@']!.map(i => [i.label, i.insert])).toEqual([['Jingga', 'JINGGA'], ['Bima', 'BIMA']]);
    expect(t['@']![0]!.avatar).toMatch(/\/cast\/JINGGA\/image\?w=160$/);
    expect(t['#']!.map(i => [i.label, i.insert])).toEqual([['Pagar rumah', 'PAGAR'], ['Jalan desa', 'JALAN']]);
    // Legacy boards: the cast map.
    expect(mentionTriggers(ID, BOARD)['@']!.map(i => i.insert)).toEqual(['JINGGA', 'BIMA']);
  });
});

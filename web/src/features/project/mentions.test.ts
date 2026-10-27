import { describe, expect, it } from 'vitest';
import { mentionTriggers as fromIntentFields } from './IntentFields.js';
import { mentionTriggers, shotUsesToken, shotsUsing } from './mentions.js';
import { bibleBoard } from './testkit.js';

describe('mentions — one rule for "this shot uses TOKEN"', () => {
  it('matches TOKEN as a whole word in the prompt or the intent subject/action', () => {
    expect(shotUsesToken({ id: 'a', prompt: 'Medium shot. JINGGA sits.' }, 'JINGGA')).toBe(true);
    expect(shotUsesToken({ id: 'a', prompt: 'x', intent: { subject: 'a cat', action: 'hugs BIMA', startState: '', endState: '' } }, 'BIMA')).toBe(true);
    expect(shotUsesToken({ id: 'a', prompt: 'JINGGA_KECIL and XJINGGA sit.' }, 'JINGGA')).toBe(false);
    expect(shotUsesToken({ id: 'a', prompt: 'x', intent: { subject: 'x', action: 'y', startState: 'JINGGA waits', endState: '' } }, 'JINGGA')).toBe(false);
  });

  it('lists the shots and their scenes (Breakdown and the character card count the same shots)', () => {
    const used = shotsUsing(bibleBoard(), 'JINGGA');
    expect(used.shots.map(s => s.id)).toEqual(['01-pagar', '03-peluk']);
    expect(used.scenes.map(s => s.id)).toEqual(['menunggu', 'pulang']);
  });

  it('mentionTriggers still imports from IntentFields (same function)', () => {
    expect(fromIntentFields).toBe(mentionTriggers);
  });
});

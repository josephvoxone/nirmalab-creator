import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntentFields, type IntentDraft } from './IntentFields.js';

const EMPTY: IntentDraft = { subject: '', action: '', startState: '', endState: '', emotion: '', framing: '', move: '' };
const SLOTS = [['Subjek', 'combobox'], ['Aksi', 'combobox'], ['Keadaan awal', 'textbox'], ['Keadaan akhir', 'textbox']] as const;
const field = ([name, role]: (typeof SLOTS)[number]) => screen.getByRole(role, { name });
const mount = (value: IntentDraft) => render(<IntentFields shotId="s1" value={value} onChange={() => undefined} triggers={{}} required />);

describe('IntentFields › required slots', () => {
  it('nothing is flagged before the user starts filling the intent', () => {
    mount(EMPTY);
    for (const slot of SLOTS) expect(field(slot)).not.toHaveAttribute('aria-invalid');
  });

  it('once any slot is filled, every empty required slot is flagged the same way — Subjek included', () => {
    for (const filled of ['subject', 'action', 'startState', 'endState'] as const) {
      const view = mount({ ...EMPTY, [filled]: 'something' });
      SLOTS.forEach((slot, i) => {
        const key = (['subject', 'action', 'startState', 'endState'] as const)[i];
        if (key === filled) expect(field(slot)).not.toHaveAttribute('aria-invalid');
        else expect(field(slot)).toHaveAttribute('aria-invalid', 'true');
      });
      view.unmount();
    }
  });
});

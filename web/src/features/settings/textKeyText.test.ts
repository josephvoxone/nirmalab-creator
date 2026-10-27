import { describe, expect, it } from 'vitest';
import { textKeyText } from './settingsClient.js';

describe('textKeyText', () => {
  it('shows the last 4 characters of the hint as they are, dots and stars included', () => {
    expect(textKeyText('••••wxyz')).toBe('Tersimpan · …wxyz');
    expect(textKeyText('••••ab.*')).toBe('Tersimpan · …ab.*');
    expect(textKeyText(undefined)).toBe('Tersimpan · …');
  });
});

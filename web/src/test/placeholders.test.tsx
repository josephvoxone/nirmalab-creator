/**
 * House rule: every field the user types into or picks from shows a placeholder (an example or a
 * hint), so an empty field never looks broken. Static scan of every page component.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Choice } from '../ui/controls.js';

const SRC = join(__dirname, '..');
const FIELD = /<(input|textarea|Input|Textarea|InputGroupInput|InputGroupTextarea)\b/g;
const NOT_TEXT = /type=["'](hidden|file|checkbox|radio|range|color|submit|button)["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'ui' && dir.endsWith('components') ? [] : name === 'test' ? [] : files(p);
    return p.endsWith('.tsx') && !p.includes('.test.') ? [p] : [];
  });
}

/** The opening tag starting at `start`, braces balanced (props hold arrow functions with `>`). */
function openingTag(s: string, start: number): string {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && s[i - 1] !== '=') return s.slice(start, i + 1);
  }
  return s.slice(start);
}

describe('placeholders', () => {
  it('every text field in the pages has a placeholder', () => {
    const missing: string[] = [];
    for (const file of files(SRC)) {
      const s = readFileSync(file, 'utf8');
      for (const m of s.matchAll(FIELD)) {
        const tag = openingTag(s, m.index!);
        if (NOT_TEXT.test(tag) || /\bplaceholder=/.test(tag)) continue;
        missing.push(`${relative(SRC, file)}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('Choice shows "Pilih…" when nothing is chosen and no placeholder is given', () => {
    render(<Choice label="Model" value="" options={[{ value: 'a', label: 'A' }]} onChange={() => undefined} />);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Pilih…');
  });
});

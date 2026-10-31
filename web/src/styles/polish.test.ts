import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The base polish lives in one stylesheet: assert the rules, not a screenshot. */
// jsdom gives `import.meta.url` an http origin, so read from the repo root instead.
const css = readFileSync(join(process.cwd(), 'web/src/styles/glass.css'), 'utf8');
/** Every block for a selector, joined — a file can declare the same selector twice (density, polish). */
const rule = (selector: string) => {
  const blocks: string[] = [];
  for (let at = css.indexOf(selector); at > -1; at = css.indexOf(selector, at + selector.length)) {
    const open = css.indexOf('{', at);
    blocks.push(css.slice(open + 1, css.indexOf('}', open)));
  }
  expect(blocks.length, `${selector} is missing from glass.css`).toBeGreaterThan(0);
  return blocks.join('\n');
};

describe('Polish dasar (make-interfaces-feel-better)', () => {
  it('smooths text at the root, not on each page', () => {
    expect(rule('html {')).toContain('-webkit-font-smoothing: antialiased');
    expect(rule('html {')).toContain('-moz-osx-font-smoothing: grayscale');
  });

  it('balances headings and prettifies paragraphs', () => {
    expect(rule('h1, h2, h3 {')).toContain('text-wrap: balance');
    expect(rule('p, li, dd, figcaption {')).toContain('text-wrap: pretty');
  });

  it('outlines media with pure white at 10%, never a tinted neutral', () => {
    const media = rule('img, video {');
    expect(media).toContain('outline: 1px solid oklch(1 0 0 / 0.1)');
    expect(media).toContain('outline-offset: -1px');
  });

  it('names the transition properties instead of animating all of them', () => {
    const button = rule('[data-slot="button"] {');
    expect(button).toContain('transition-property: color, background-color, border-color, box-shadow, scale, translate, opacity');
    expect(button).not.toContain('transition: all');
    expect(button).not.toContain('transition-property: all');
  });

  it('presses to exactly 0.96 and gives icon buttons a 40/44 px target', () => {
    expect(css).toContain('scale: 0.96');
    // Measured in the browser: our icon-only button is 30 px wide, so the pseudo-element needs 5 px each side
    // for the 40 px mouse minimum and 7 px for the 44 px touch target (inset -4 gave only 36 px = below spec).
    expect(css).toContain('inset: -5px');   // 30 px icon + 5 px each side = 40 px
    expect(css).toContain('inset: -7px');   // touch: 30 + 14 = 44 px
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

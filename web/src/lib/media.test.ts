import { describe, expect, it } from 'vitest';
import { IMAGE_WIDTHS, pickWidth, poster, sized, sizedImg } from './media.js';

describe('sized', () => {
  it('appends w= to a bare url', () => {
    expect(sized('/api/stories/s/shots/a/frame', 320)).toBe('/api/stories/s/shots/a/frame?w=320');
  });

  it('keeps an existing query and hash', () => {
    expect(sized('/api/stories/templates/t/cover?v=12', 480)).toBe('/api/stories/templates/t/cover?v=12&w=480');
    expect(sized('/x?v=1#t=1.5', 160)).toBe('/x?v=1&w=160#t=1.5');
  });

  it('replaces a w= that is already there instead of adding a second one', () => {
    expect(sized('/x?w=1080&v=3', 160)).toBe('/x?w=160&v=3');
  });

  it('snaps to the widths the server renders (never asks for a size it would refuse)', () => {
    expect(IMAGE_WIDTHS).toEqual([160, 320, 480, 720, 1080]);
    expect(pickWidth(20)).toBe(160);
    expect(pickWidth(161)).toBe(320);
    expect(pickWidth(480)).toBe(480);
    expect(pickWidth(4000)).toBe(1080);
    expect(sized('/x', 96)).toBe('/x?w=160');
  });
});

describe('sizedImg', () => {
  it('gives src for the box and a 2x srcSet when the 2x variant is bigger', () => {
    expect(sizedImg('/c?v=1', 240)).toEqual({ src: '/c?v=1&w=320', srcSet: '/c?v=1&w=320 1x, /c?v=1&w=480 2x' });
  });

  it('drops srcSet when 1x and 2x are the same file', () => {
    expect(sizedImg('/c', 20)).toEqual({ src: '/c?w=160' });
    expect(sizedImg('/c', 1080)).toEqual({ src: '/c?w=1080' });
  });
});

describe('poster', () => {
  it('points at the poster endpoints with a cache version and a width', () => {
    expect(poster.final('s1', 480, '99')).toBe('/api/stories/s1/video/poster?v=99&w=480');
    expect(poster.shot('s1', '01-a', 320, 'job1')).toBe('/api/stories/s1/shots/01-a/poster?v=job1&w=320');
    expect(poster.shot('s1', '01-a', 100)).toBe('/api/stories/s1/shots/01-a/poster?w=160');
  });
});

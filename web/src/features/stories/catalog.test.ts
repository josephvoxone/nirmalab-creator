import { describe, expect, it } from 'vitest';
import { readSetup, setShotSetup } from './catalog.js';
import { CATALOG } from './testCatalog.js';

describe('shot setup helpers', () => {
  it('reads and rewrites the framing + move sentence', () => {
    const p = 'Medium shot, the camera stays still. LARAS hugs KAPAS.';
    expect(readSetup(p, CATALOG)).toEqual({ framing: 'medium', move: 'static' });
    expect(setShotSetup(p, CATALOG, 'close-up', 'push-in')).toBe('Close-up, the camera pushes in slowly. LARAS hugs KAPAS.');
    expect(setShotSetup('KAPAS waits.', CATALOG, 'wide', 'static')).toBe('Wide shot, the camera stays still. KAPAS waits.');
  });
});

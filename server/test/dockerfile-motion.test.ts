import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'));

describe('Dockerfile: what the motion QC needs in the production image', () => {
  it('the runtime stage installs python3-numpy next to ffmpeg/python3/python3-pil, and nothing heavier', () => {
    const apt = /apt-get install[^\n]*(?:\\\n[^\n]*)*/.exec(runtime)?.[0] ?? '';
    for (const pkg of ['ffmpeg', 'python3', 'python3-pil', 'python3-numpy', 'ca-certificates']) expect(apt).toMatch(new RegExp(`\\b${pkg}\\b`));
    for (const heavy of ['scipy', 'opencv', 'python3-pip', 'build-essential']) expect(apt).not.toContain(heavy);
  });
  it('bridge/py (clipqc.py included) is copied into the image and the server finds the script there', () => {
    expect(runtime).toMatch(/COPY bridge\/py \.\/bridge\/py/);
    expect(runtime).toMatch(/STORY_PYTHON=python3/);
  });
});

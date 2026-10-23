import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { synthesizeTts } from '../src/generate/tts.js';

describe('edge tts', () => {
  it('writes mp3 via injected runner', async () => {
    const run = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const outDir = mkdtempSync(join(tmpdir(), 'tts-'));
    const out = await synthesizeTts({ text: 'Halo dunia', voice: 'id-ID-ArdiNeural' }, outDir, run as never, () => 7);
    expect(out.bytes).toBe(4);
    expect(out.filePath.startsWith(outDir)).toBe(true);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ voice: 'id-ID-ArdiNeural' });
  });

  it('defaults to Indonesian voice and rejects empty/oversize', async () => {
    const run = vi.fn().mockResolvedValue(new Uint8Array([9]));
    const outDir = mkdtempSync(join(tmpdir(), 'tts-'));
    await synthesizeTts({ text: 'Hai' }, outDir, run as never);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ voice: 'id-ID-GadisNeural' });
    await expect(synthesizeTts({ text: '  ' }, outDir, run as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(synthesizeTts({ text: 'x'.repeat(5001) }, outDir, run as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const empty = vi.fn().mockResolvedValue(new Uint8Array(0));
    await expect(synthesizeTts({ text: 'Hai' }, outDir, empty as never)).rejects.toMatchObject({ code: 'TTS_FAILED' });
  });
});

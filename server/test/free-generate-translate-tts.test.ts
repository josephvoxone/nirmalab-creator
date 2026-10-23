import { describe, expect, it, vi } from 'vitest';
import { googleTtsMp3, splitTtsText } from '../src/generate/translate-tts.js';

function mp3Response(size: number): Response {
  return new Response(new Uint8Array(size).fill(7), { status: 200 });
}

describe('google translate tts', () => {
  it('splits on sentences and packs to 200 chars', () => {
    expect(splitTtsText('Halo. Apa kabar?')).toEqual(['Halo. Apa kabar?']);
    expect(splitTtsText('x'.repeat(250))).toHaveLength(2);
    expect(splitTtsText('  ')).toEqual([]);
  });

  it('concatenates chunk audio', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(mp3Response(150))
      .mockResolvedValueOnce(mp3Response(200));
    const out = await googleTtsMp3(`${'a'.repeat(150)}. ${'b'.repeat(150)}.`, { fetchImpl: fetchImpl as never });
    expect(out.byteLength).toBe(350);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('tl=id');
  });

  it('fails cleanly on upstream errors', async () => {
    const bad = vi.fn().mockResolvedValue(new Response('nope', { status: 429 }));
    await expect(googleTtsMp3('Hai', { fetchImpl: bad as never })).rejects.toMatchObject({ code: 'TTS_FAILED' });
    await expect(googleTtsMp3('   ', { fetchImpl: bad as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

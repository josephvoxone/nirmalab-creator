import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pollinationsImage, pollinationsModels, pollinationsText, pollinationsVideo } from '../src/generate/pollinations.js';

function binResponse(size: number, contentType = 'video/mp4'): Response {
  return new Response(new Uint8Array(size).fill(3), { status: 200, headers: { 'Content-Type': contentType } });
}

describe('pollinations video', () => {
  it('submits async, polls to success, saves mp4', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job1' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded', result_url: 'https://cdn/x.mp4' }), { status: 200 }))
      .mockResolvedValueOnce(binResponse(5000));
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    const out = await pollinationsVideo(
      fetchImpl as never,
      { prompt: 'sunset timelapse', aspect: '16:9', durationSec: 4 },
      outDir,
      () => 9
    );
    expect(out.bytes).toBe(5000);
    expect(readFileSync(out.filePath).byteLength).toBe(5000);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/video/sunset%20timelapse');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('width=1280&height=720');
  }, 30_000);

  it('handles sync cached mp4 + failures', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    const sync = vi.fn().mockResolvedValueOnce(binResponse(2048));
    const out = await pollinationsVideo(sync as never, { prompt: 'cat' }, outDir, () => 1);
    expect(out.bytes).toBe(2048);
    const denied = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(pollinationsVideo(denied as never, { prompt: 'cat' }, outDir)).rejects.toMatchObject({ code: 'NEEDS_KEY' });
    const failed = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', error: { message: 'blocked' } }), { status: 200 }));
    await expect(pollinationsVideo(failed as never, { prompt: 'cat' }, outDir)).rejects.toMatchObject({ code: 'GENERATE_FAILED' });
  }, 30_000);
});

describe('pollinations text', () => {
  it('mengirim prompt + model dan mengembalikan teks', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Halo!' } }] }), { status: 200 })
    );
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    const out = await pollinationsText(fetchImpl as never, { prompt: 'sapa aku', model: 'qwen/qwen3.8-flash' }, outDir);
    expect(out.text).toBe('Halo!');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/chat/completions');
    expect(String(init.body)).toContain('qwen/qwen3.8-flash');
  });

  it('gagal cepat saat menggantung', async () => {
    const hanging = vi.fn().mockImplementation(() => new Promise(() => {}));
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    await expect(
      pollinationsText(hanging as never, { prompt: 'x' }, outDir, { timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('mengambil daftar model', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.8-flash' }, { id: 'deepseek/deepseek-v4.1-flash' }] }), { status: 200 })
    );
    const models = await pollinationsModels(fetchImpl as never);
    expect(models).toEqual(['qwen/qwen3.8-flash', 'deepseek/deepseek-v4.1-flash']);
  });
});

describe('pollinations image', () => {
  it('downloads and saves jpg', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binResponse(3000, 'image/jpeg'));
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    const out = await pollinationsImage(fetchImpl as never, { prompt: 'poster' }, outDir, () => 2);
    expect(out.bytes).toBe(3000);
    expect(out.filePath.endsWith('.jpg')).toBe(true);
  });

  it('gagal cepat saat fetch menggantung (timeout)', async () => {
    const hanging = vi.fn().mockImplementation(() => new Promise(() => {}));
    const outDir = mkdtempSync(join(tmpdir(), 'pol-'));
    await expect(
      pollinationsVideo(hanging as never, { prompt: 'cat' }, outDir, () => 3, { timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

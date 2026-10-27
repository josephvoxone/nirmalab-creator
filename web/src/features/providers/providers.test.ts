import { describe, expect, it } from 'vitest';
import { clipCost, fmtUsd, savedKeyText, shortPrice, sortVideoModels } from './providersClient.js';
import { engineFor, estimateUsd, openRouterOption, type EngineCatalog } from './useEngines.js';
import { CONFIGURED, MODELS, UNCONFIGURED } from './fixtures.js';

const cat = (over: Partial<EngineCatalog> = {}): EngineCatalog => ({ status: 'ready', providers: CONFIGURED, models: MODELS, reload: () => undefined, ...over });

describe('clipCost: what rendering N clips costs on the chosen engine', () => {
  it('Flow in credits, OpenRouter in USD when known, Axcel as part of the plan', () => {
    expect(clipCost(undefined, 2)).toBe('±20 kredit');
    expect(clipCost({ provider: 'flow' }, 1)).toBe('±10 kredit');
    expect(clipCost({ provider: 'openrouter', model: 'google/veo-3.1-lite' }, 4, 0.3)).toBe('±$1,20 OpenRouter');
    expect(clipCost({ provider: 'openrouter', model: 'google/veo-3.1-lite' }, 4)).toBe('OpenRouter');
    expect(clipCost({ provider: 'axcel', model: 'Seedance 2.0' }, 20)).toBe('Axcel Seedance 2.0 · termasuk paket');
  });
});

describe('provider helpers', () => {
  it('sorts video models by price per clip, unknown prices last', () => {
    expect(sortVideoModels(MODELS.video).map(m => m.id)).toEqual(['google/veo-3.1-lite', 'kling/kling-2', 'google/veo-3.1', 'x/mystery']);
  });

  it('formats USD the Indonesian way', () => {
    expect(fmtUsd(0.3)).toBe('$0,30');
    expect(fmtUsd(12.5)).toBe('$12,50');
    expect(shortPrice('video', MODELS.video[2])).toBe('±$0,30/klip');
    expect(shortPrice('image', MODELS.image[1])).toBe('±$0,04/gambar');
    expect(shortPrice('video', MODELS.video[1])).toBe('harga belum diketahui');
  });

  it('shows only the last four characters of the key hint', () => {
    expect(savedKeyText('••••c0de')).toBe('Tersimpan ••••c0de');
    expect(savedKeyText('c0de')).toBe('Tersimpan ••••c0de');
  });

  it('labels the OpenRouter option with the default model and its price', () => {
    const o = openRouterOption(cat(), 'video');
    expect(o).toMatchObject({ available: true, label: 'OpenRouter · Veo 3.1 Lite · ±$0,30/klip', modelId: 'google/veo-3.1-lite' });
    expect(openRouterOption(cat(), 'image').label).toBe('OpenRouter · Nano Banana · ±$0,04/gambar');
    expect(engineFor('openrouter', o)).toEqual({ provider: 'openrouter', model: 'google/veo-3.1-lite' });
    expect(engineFor('flow', o)).toEqual({ provider: 'flow' });
  });

  it('keeps a project model over the default', () => {
    expect(openRouterOption(cat(), 'video', { provider: 'openrouter', model: 'google/veo-3.1' }).label).toBe('OpenRouter · Veo 3.1 · ±$2,40/klip');
  });

  it('is disabled with a setup hint when OpenRouter is not configured, loading or unreachable', () => {
    for (const c of [cat({ providers: UNCONFIGURED, models: undefined }), cat({ status: 'error', providers: undefined })]) {
      const o = openRouterOption(c, 'video');
      expect(o).toMatchObject({ available: false, label: 'OpenRouter', hint: 'Atur di Pengaturan › Provider' });
      expect(engineFor('openrouter', o)).toEqual({ provider: 'flow' });
    }
    expect(openRouterOption(cat({ status: 'loading', providers: undefined }), 'video').available).toBe(false);
    const noDefault = cat({ providers: { ...CONFIGURED, openrouter: { ...CONFIGURED.openrouter, defaults: {} } } });
    expect(openRouterOption(noDefault, 'video')).toMatchObject({ available: false, hint: expect.stringMatching(/model video bawaan/) });
  });

  it('estimates cost as clips × usdPerClip', () => {
    expect(estimateUsd('video', MODELS.video[2], 8)).toBeCloseTo(2.4);
    expect(estimateUsd('video', MODELS.video[1], 8)).toBeNull();
  });
});

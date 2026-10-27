/**
 * What the engine pickers need: is OpenRouter set up, which default models, their names + prices.
 * Loaded once per mount; a failure (offline, or a member without access) only disables OpenRouter —
 * Google Flow always stays pickable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FetchLike } from '../../lib/api.js';
import { AXCEL_DEFAULT_MODEL, isAxcel, isOpenRouter, providersApi, shortPrice, type Engine, type MediaKind, type ModelInfo, type Models, type Providers } from './providersClient.js';

export type EngineCatalog = {
  status: 'loading' | 'ready' | 'error';
  providers?: Providers;
  models?: Models;
  error?: unknown;
  reload: () => void;
};

export function useEngines(fetchImpl: FetchLike): EngineCatalog {
  const api = useMemo(() => providersApi(fetchImpl), [fetchImpl]);
  const [state, setState] = useState<Omit<EngineCatalog, 'reload'>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, status: s.providers ? s.status : 'loading' }));
    (async () => {
      try {
        const providers = await api.get();
        let models: Models | undefined;
        if (providers?.openrouter?.configured) {
          try { models = await api.models(); } catch { models = undefined; /* names fall back to ids */ }
        }
        if (alive) setState({ status: 'ready', providers, models });
      } catch (error) {
        if (alive) setState({ status: 'error', error });
      }
    })();
    return () => { alive = false; };
  }, [api, tick]);
  const reload = useCallback(() => setTick(t => t + 1), []);
  return { ...state, reload };
}

export const SETUP_HINT = 'Atur di Pengaturan › Provider';

export type OpenRouterOption = {
  /** OpenRouter can be picked for this kind right now. */
  available: boolean;
  /** "OpenRouter · Veo 3.1 Lite · ±$0,30/klip" or just "OpenRouter". */
  label: string;
  /** Why it cannot be picked (shown under the option). */
  hint?: string;
  modelId?: string;
  model?: ModelInfo;
};

/** The OpenRouter option for one kind; `current` keeps a project's own model when it has one. */
export function openRouterOption(cat: EngineCatalog, kind: MediaKind, current?: Engine): OpenRouterOption {
  const or = cat.providers?.openrouter;
  const modelId = isOpenRouter(current) ? current.model : or?.defaults?.[kind] ?? undefined;
  const list = Array.isArray(cat.models?.[kind]) ? cat.models![kind] : [];
  const model = modelId ? list.find(m => m.id === modelId) : undefined;
  const configured = cat.status === 'ready' && !!or?.configured;
  const available = configured && !!modelId;
  const label = !modelId || !(configured || isOpenRouter(current)) ? 'OpenRouter'
    : !model && cat.status === 'loading' ? `OpenRouter · ${modelId}`
    : `OpenRouter · ${model?.name ?? modelId} · ${shortPrice(kind, model)}`;
  const hint = available ? undefined
    : cat.status === 'loading' ? 'Memuat pengaturan provider…'
    : configured ? `Pilih model ${kind === 'video' ? 'video' : 'gambar'} bawaan di Pengaturan › Provider`
    : SETUP_HINT;
  return { available, label, hint, modelId, model };
}

/** Axcel (Gold plan, through the Mac bridge): no per-clip price, one fixed model per kind. */
export type AxcelOption = { available: boolean; label: string; hint?: string; modelId: string };

export function axcelOption(cat: EngineCatalog, kind: MediaKind, current?: Engine): AxcelOption {
  const state = cat.providers?.axcel;
  const modelId = isAxcel(current) ? current.model : AXCEL_DEFAULT_MODEL[kind];
  const plan = state?.health?.plan ? state.health.plan.replace(/^./, c => c.toUpperCase()) : undefined;
  const configured = cat.status === 'ready' && !!state?.configured && !state.error;
  return {
    available: configured,
    label: `Axcel${plan ? ` · ${plan}` : ''} · ${modelId}`,
    modelId,
    hint: configured ? undefined
      : cat.status === 'loading' ? 'Memuat pengaturan provider…'
      : state?.error ? `Bridge Axcel: ${state.error}`
      : state?.configured ? SETUP_HINT : 'Jalankan bridge Axcel di Mac lalu isi tokennya di Pengaturan › Provider'
  };
}

/** The engine to send when the user picked `provider` for this kind. */
export function engineFor(provider: Engine['provider'], option: OpenRouterOption, axcel?: AxcelOption): Engine {
  if (provider === 'axcel') return axcel?.available ? { provider: 'axcel', model: axcel.modelId } : { provider: 'flow' };
  return provider === 'openrouter' && option.available && option.modelId ? { provider: 'openrouter', model: option.modelId } : { provider: 'flow' };
}

/** clips × usdPerClip (or images × usdPerImage); null when the price is unknown. */
export function estimateUsd(kind: MediaKind, model: ModelInfo | undefined, count: number): number | null {
  const n = kind === 'video' ? model?.usdPerClip : model?.usdPerImage;
  return typeof n === 'number' ? n * count : null;
}

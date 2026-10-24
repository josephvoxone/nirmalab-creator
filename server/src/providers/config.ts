/**
 * OpenRouter key + default models, stored in `<dataDir>/providers/openrouter.json` (0600).
 * The key is never returned by `view()` (only `keyHint`, the last 4 chars) and never logged.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';

export type ProviderId = 'flow' | 'openrouter';
export type Engine = { provider: 'flow' } | { provider: 'openrouter'; model: string };
export type EngineKind = 'image' | 'video';

export type OpenRouterDefaults = { image?: string; video?: string };
export type OpenRouterView = { configured: boolean; keyHint?: string; defaults: OpenRouterDefaults };
export type OpenRouterPatch = { apiKey?: string | null; defaults?: { image?: string | null; video?: string | null } };

type Stored = { apiKey?: string; defaults?: OpenRouterDefaults };

/** OpenRouter model slug, e.g. `google/veo-3.1-fast` or `openai/gpt-image-1:free`. */
export const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;
export const isModelId = (value: unknown): value is string => typeof value === 'string' && value.length <= 120 && MODEL_ID.test(value);

/** Bad input to an update (routes map it to 400). */
export class ProviderInputError extends Error {}

export class OpenRouterConfigStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'providers', 'openrouter.json');
  }

  private async read(): Promise<Stored> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private static view(stored: Stored): OpenRouterView {
    const defaults: OpenRouterDefaults = {};
    for (const kind of ['image', 'video'] as const) if (isModelId(stored.defaults?.[kind])) defaults[kind] = stored.defaults![kind];
    return stored.apiKey
      ? { configured: true, keyHint: `••••${stored.apiKey.slice(-4)}`, defaults }
      : { configured: false, defaults };
  }

  async view(): Promise<OpenRouterView> {
    return OpenRouterConfigStore.view(await this.read());
  }

  async apiKey(): Promise<string | undefined> {
    const key = (await this.read()).apiKey;
    return typeof key === 'string' && key ? key : undefined;
  }

  async update(patch: OpenRouterPatch): Promise<OpenRouterView> {
    if (patch.apiKey !== undefined && patch.apiKey !== null) {
      const key = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
      if (key.length < 20 || key.length > 300 || /\s/.test(key)) throw new ProviderInputError('API key OpenRouter tidak valid');
    }
    for (const kind of ['image', 'video'] as const) {
      const value = patch.defaults?.[kind];
      if (value !== undefined && value !== null && !isModelId(value)) throw new ProviderInputError(`defaults.${kind}: model id tidak valid`);
    }
    const run = this.queue.then(async () => {
      const stored = await this.read();
      const next: Stored = { ...stored, defaults: { ...(stored.defaults ?? {}) } };
      if (patch.apiKey === null) delete next.apiKey;
      else if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim();
      for (const kind of ['image', 'video'] as const) {
        const value = patch.defaults?.[kind];
        if (value === null) delete next.defaults![kind];
        else if (value !== undefined) next.defaults![kind] = value;
      }
      await writePrivateJsonFile(this.path, next);
      return OpenRouterConfigStore.view(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

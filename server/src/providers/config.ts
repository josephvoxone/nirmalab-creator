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
export type OpenRouterView = {
  configured: boolean;
  keyHint?: string;
  defaults: OpenRouterDefaults;
  /** Vision model that audits takes (spec §4.4); always set, default when not chosen. */
  auditModel: string;
};
export type OpenRouterPatch = {
  apiKey?: string | null;
  defaults?: { image?: string | null; video?: string | null };
  /** `null` restores the default. */
  auditModel?: string | null;
};

type Stored = { apiKey?: string; defaults?: OpenRouterDefaults; auditModel?: string };

/** The vision model used when nobody picked one (cheap, accepts images). */
export const DEFAULT_AUDIT_MODEL = 'google/gemini-2.5-flash';

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
    const auditModel = isModelId(stored.auditModel) ? stored.auditModel : DEFAULT_AUDIT_MODEL;
    return stored.apiKey
      ? { configured: true, keyHint: `••••${stored.apiKey.slice(-4)}`, defaults, auditModel }
      : { configured: false, defaults, auditModel };
  }

  async view(): Promise<OpenRouterView> {
    return OpenRouterConfigStore.view(await this.read());
  }

  async apiKey(): Promise<string | undefined> {
    const key = (await this.read()).apiKey;
    return typeof key === 'string' && key ? key : undefined;
  }

  /** Model that audits takes: the stored pick, else the default. Never empty. */
  async auditModel(): Promise<string> {
    const stored = (await this.read()).auditModel;
    return isModelId(stored) ? stored : DEFAULT_AUDIT_MODEL;
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
    if (patch.auditModel !== undefined && patch.auditModel !== null && !isModelId(patch.auditModel)) {
      throw new ProviderInputError('auditModel: model id tidak valid');
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
      if (patch.auditModel === null) delete next.auditModel;
      else if (patch.auditModel !== undefined) next.auditModel = patch.auditModel;
      await writePrivateJsonFile(this.path, next);
      return OpenRouterConfigStore.view(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

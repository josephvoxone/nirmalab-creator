/**
 * OpenCode Go key + chosen text model, stored in `<dataDir>/providers/opencode-go.json` (0600).
 * The key is never returned by `view()` (only `keyHint`, the last 4 chars) and never logged.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import { ProviderInputError } from '../providers/config.js';

/** Models the settings offer; the first three are the fallback chain (see `TEXT_CHAIN`). */
export const TEXT_MODELS = ['glm-5.3', 'glm-5.3-flash', 'beam-free', 'deepseek-v4-pro'] as const;
export type TextModelId = (typeof TEXT_MODELS)[number];
export const DEFAULT_TEXT_MODEL: TextModelId = 'glm-5.3';
export const isTextModel = (value: unknown): value is TextModelId => typeof value === 'string' && (TEXT_MODELS as readonly string[]).includes(value);

export type TextModelView = { configured: boolean; keyHint?: string; model: TextModelId };
export type TextModelPatch = { apiKey?: string | null; model?: string };

type Stored = { apiKey?: string; model?: string };

export class TextModelConfigStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'providers', 'opencode-go.json');
  }

  private async read(): Promise<Stored> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private static view(stored: Stored): TextModelView {
    const model = isTextModel(stored.model) ? stored.model : DEFAULT_TEXT_MODEL;
    return stored.apiKey ? { configured: true, keyHint: `••••${stored.apiKey.slice(-4)}`, model } : { configured: false, model };
  }

  async view(): Promise<TextModelView> {
    return TextModelConfigStore.view(await this.read());
  }

  async key(): Promise<string | undefined> {
    const key = (await this.read()).apiKey;
    return typeof key === 'string' && key ? key : undefined;
  }

  async patch(patch: TextModelPatch): Promise<TextModelView> {
    if (patch.apiKey !== undefined && patch.apiKey !== null) {
      const key = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
      if (key.length < 12 || key.length > 300 || /\s/.test(key)) throw new ProviderInputError('API key OpenCode Go tidak valid');
    }
    if (patch.model !== undefined && !isTextModel(patch.model)) throw new ProviderInputError(`model harus salah satu dari: ${TEXT_MODELS.join(', ')}`);
    const run = this.queue.then(async () => {
      const next: Stored = { ...(await this.read()) };
      if (patch.apiKey === null) delete next.apiKey;
      else if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim();
      if (patch.model !== undefined) next.model = patch.model;
      await writePrivateJsonFile(this.path, next);
      return TextModelConfigStore.view(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

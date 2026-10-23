import { FreeGenerateError, type FreeClipRequest, type FreeClipResult } from './types.js';
import type { AccountPoolStore } from './accounts.js';

export type ClipContext = {
  outDir: string;
  pools: AccountPoolStore;
  signal?: AbortSignal;
};

export type ClipProvider = {
  readonly name: string;
  readonly dailyCapPerAccount?: number;
  generate(request: FreeClipRequest, ctx: ClipContext): Promise<FreeClipResult>;
};

/** Try providers in order; browser pools cool down per account, API providers throw to fail over. */
export class GenerateRouter {
  private readonly providers: ClipProvider[] = [];

  register(provider: ClipProvider): void {
    this.providers.push(provider);
  }

  get names(): string[] {
    return this.providers.map(p => p.name);
  }

  async generate(request: FreeClipRequest, ctx: ClipContext): Promise<FreeClipResult> {
    const prompt = request.prompt.trim().slice(0, 2000);
    if (!prompt) throw new FreeGenerateError('INVALID_INPUT', 'Prompt is required');
    if (this.providers.length === 0) throw new FreeGenerateError('NO_PROVIDER', 'No generate providers registered');
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        const account = await ctx.pools.pick(provider.name, provider.dailyCapPerAccount);
        void account;
        const result = await provider.generate({ ...request, prompt }, ctx);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.name}: ${message.slice(0, 160)}`);
      }
    }
    throw new FreeGenerateError('ALL_FAILED', `All providers failed — ${errors.join(' | ')}`.slice(0, 500));
  }
}

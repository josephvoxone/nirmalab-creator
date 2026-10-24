/**
 * Template cover stills, generated through the app's Flow queue (never by driving Flow
 * directly). Pending job ids live in <data>/covers/index.json; finished stills are copied
 * to <data>/covers/<template>.<ext> and win over the bundled web/public/templates/*.jpg.
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStore } from '../flow/store.js';
import { CATALOG, composeStyle } from './looks.js';
import { StoryError } from './service.js';

export type CoverState = { pending: boolean; jobId?: string; error?: string; updatedAtMs?: number };
type Index = Record<string, CoverState>;

export class CoverService {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: { dataDir: string; flow: FlowStore; webDist?: string }) {
    this.dir = join(deps.dataDir, 'covers');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Index> {
    try { return JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as Index; } catch { return {}; }
  }

  private async write(index: Index) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `index.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, join(this.dir, 'index.json'));
  }

  promptFor(templateId: string): string {
    const t = CATALOG.templates.find(x => x.id === templateId);
    if (!t) throw new StoryError('NOT_FOUND', 'Template not found');
    return `${t.cover} ${composeStyle(t.look)} Wide 16:9 cinematic still, no text, no letters, no watermark.`;
  }

  async queue(templateId: string): Promise<CoverState> {
    const prompt = this.promptFor(templateId);
    return this.serial(async () => {
      const index = await this.settle(await this.read());
      if (index[templateId]?.pending) throw new StoryError('BUSY', 'Cover sedang dibuat');
      const job = await this.deps.flow.createJob({ prompt, kind: 'image', aspect: '16:9', durationSec: 6, technique: `cover:${templateId}` });
      index[templateId] = { ...index[templateId], pending: true, jobId: job.id, error: undefined };
      await this.write(index);
      return index[templateId]!;
    });
  }

  /** Copy finished stills into place, record failures. */
  private async settle(index: Index): Promise<Index> {
    let changed = false;
    for (const [id, state] of Object.entries(index)) {
      if (!state.pending || !state.jobId) continue;
      const job = await this.deps.flow.getJob(state.jobId);
      if (!job || job.status === 'failed') {
        index[id] = { ...state, pending: false, error: job?.error ?? 'Job Flow hilang' };
        changed = true;
      } else if (job.status === 'done' && job.resultPath) {
        await mkdir(this.dir, { recursive: true });
        await copyFile(job.resultPath, join(this.dir, `${id}.img`));
        index[id] = { pending: false, updatedAtMs: Date.now() };
        changed = true;
      }
    }
    if (changed) await this.write(index);
    return index;
  }

  async status(): Promise<Index> {
    return this.serial(async () => this.settle(await this.read()));
  }

  /** Path of the cover to serve: app-made first, bundled second. */
  async file(templateId: string): Promise<string | undefined> {
    if (!CATALOG.templates.some(t => t.id === templateId)) return undefined;
    await this.status();
    const made = join(this.dir, `${templateId}.img`);
    if (existsSync(made) && (await stat(made)).size > 0) return made;
    const bundled = this.deps.webDist ? join(this.deps.webDist, 'templates', `${templateId}.jpg`) : undefined;
    return bundled && existsSync(bundled) ? bundled : undefined;
  }
}

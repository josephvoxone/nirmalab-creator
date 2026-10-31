/**
 * Trail of what the system admin did to accounts and orphaned projects: WHO, WHAT, WHEN and the TARGET id. Never project content.
 * `<dataDir>/audit/tenancy-log.jsonl`, 0600, one JSON object per line, append-only. The only title that ever lands here is the one of
 * an orphan the admin deleted (the grave, `yatim.hapus`): that title was already visible to the admin in the orphan list.
 */
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AuditDetail = Record<string, string | number | boolean | null>;
export type AuditInput = { by: string; action: string; targetId: string; targetEmail?: string; detail?: AuditDetail };
export type AuditEntry = AuditInput & { atMs: number; byEmail: string | null };

const MAX_LIMIT = 500;

export class AdminAuditLog {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, private readonly emailOf: (userId: string) => string | undefined = () => undefined, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, 'audit', 'tenancy-log.jsonl');
  }

  /** Appends one line. Calls are serialised so lines never interleave. */
  append(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      atMs: this.now(), by: input.by, byEmail: this.emailOf(input.by) ?? null, action: input.action, targetId: input.targetId,
      ...(input.targetEmail === undefined ? {} : { targetEmail: input.targetEmail }), ...(input.detail ? { detail: input.detail } : {})
    };
    const run = this.queue.catch(() => undefined).then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(this.file, 0o600).catch(() => undefined);
    });
    this.queue = run;
    return run;
  }

  /** Newest first; a damaged line is skipped. */
  async list(limit = 100): Promise<AuditEntry[]> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const out: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (e && typeof e.atMs === 'number' && typeof e.action === 'string') out.push(e);
      } catch { /* damaged line */ }
    }
    return out.reverse().slice(0, Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || 100)));
  }
}

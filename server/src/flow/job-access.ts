import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowJob } from './store.js';
import type { WorkspaceRole } from '../tenancy/workspace-role.js';
import { jobCredits } from './store.js';

/**
 * Who a Flow job belongs to (tenancy T4, audit 06 §B row 4/5). A job is private to the user that queued it
 * (`createdBy`, set from the project's owner for story jobs). Two exceptions, both resolved here so every route agrees:
 *  - a job with no `createdBy` (made before attribution existed) belongs to the MAIN owner;
 *  - a shared template cover (`cover:<id>` technique) or a `system:*` owner belongs to the system: no user session reads it.
 */
export const SYSTEM_OWNER = 'system:cover';

export function isSystemJob(job: Pick<FlowJob, 'createdBy' | 'technique'>): boolean {
  if (job.createdBy) return job.createdBy.startsWith('system:');
  return job.technique?.startsWith('cover:') === true;
}

/** The owner id of a job, `undefined` when nobody (a system job, or an ownerless job with no main owner to inherit it). */
export function jobOwnerId(job: Pick<FlowJob, 'createdBy' | 'technique'>, mainOwnerId: string | undefined): string | undefined {
  if (isSystemJob(job)) return undefined;
  return job.createdBy || mainOwnerId || undefined;
}

export function ownsJob(job: Pick<FlowJob, 'createdBy' | 'technique'>, userId: string, mainOwnerId: string | undefined): boolean {
  return jobOwnerId(job, mainOwnerId) === userId;
}

/**
 * WAVE 4: the caller's role on a job. A job of a PROJECT is reached through that project's workspace (owner/editor/viewer),
 * and only through it: an editor who left keeps nothing, and a viewer sees the job but cannot cancel it. A Studio job (no
 * project) stays the personal object of whoever queued it, with the pre-attribution fallback to the main owner.
 */
export type JobRoleDeps = {
  /** `StoryService.roleFor`: the caller's workspace role on a project, undefined when not a member. */
  roleForProject?: (storyId: string, userId: string) => Promise<WorkspaceRole | undefined>;
  /** The account that owned the jobs of the time before attribution. */
  mainOwnerId?: string | undefined;
};

export async function jobRole(
  job: Pick<FlowJob, 'createdBy' | 'technique' | 'group'>,
  userId: string,
  deps: JobRoleDeps = {}
): Promise<WorkspaceRole | undefined> {
  if (!userId || isSystemJob(job)) return undefined;
  if (job.group && job.group.startsWith('story_')) return deps.roleForProject?.(job.group, userId);
  if (job.createdBy) return job.createdBy === userId ? 'owner' : undefined;
  return deps.mainOwnerId && deps.mainOwnerId === userId ? 'owner' : undefined;
}

/** What an operator may see of a job: load, state, time and owner id; never the prompt, technique, group, characters or result. */
export type AdminJobView = {
  id: string; kind: FlowJob['kind']; status: FlowJob['status']; provider: string; model?: string; accountId?: string;
  attempts: number; error?: string; ownerId?: string; ownerEmail?: string;
  createdAtMs: number; startedAtMs?: number; finishedAtMs?: number; credits: number; cancelled?: true;
};

const ERROR_CAP = 200;

export function adminJobView(job: FlowJob, owner: { id?: string; email?: string }): AdminJobView {
  return {
    id: job.id, kind: job.kind, status: job.status, provider: job.provider ?? 'flow',
    ...(job.model ? { model: job.model } : {}),
    ...(job.accountId ? { accountId: job.accountId } : {}),
    attempts: job.attempts,
    ...(job.error ? { error: job.error.slice(0, ERROR_CAP) } : {}),
    ...(owner.id ? { ownerId: owner.id } : {}),
    ...(owner.email ? { ownerEmail: owner.email } : {}),
    createdAtMs: job.createdAtMs,
    ...(job.startedAtMs ? { startedAtMs: job.startedAtMs } : {}),
    ...(job.finishedAtMs ? { finishedAtMs: job.finishedAtMs } : {}),
    credits: jobCredits(job.kind),
    ...(job.cancelled ? { cancelled: true as const } : {})
  };
}

/** One JSON line per operator action in `<data>/audit/tenancy-log.jsonl` (ids and times only, never content). */
export async function appendTenancyLog(dataDir: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(dataDir, 'audit');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, 'tenancy-log.jsonl'), `${JSON.stringify({ atMs: Date.now(), ...entry })}\n`, { mode: 0o600 });
}

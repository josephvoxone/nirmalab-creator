/**
 * Backfill of `createdBy` on Flow jobs that have none (tenancy T4, audit 06 §C.2). Who gets a job:
 *  - `cover:*` technique (shared template covers)        -> `system:cover`
 *  - a story job (`group` or `story:<id>/…` technique)   -> that project's owner (an orphan keeps its dead owner's id: nobody reads it);
 *                                                          a project that no longer exists -> main owner
 *  - anything else (Studio)                              -> main owner
 * Only `createdBy` is written: no other field of a job, no ordering, no project file, nothing that feeds a clip/keyframe hash.
 * Same safety as the other tenancy migrations: dry run, backup of flow.json, manifest, rollback, idempotent (a second run finds no job
 * without an owner and writes nothing).
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_OWNER } from './job-access.js';
import type { FlowJob, FlowStore } from './store.js';

export const JOB_BACKFILL_ID = 'migrasi-jobs-1';
export type JobBackfillReport = { assigned: Array<{ id: string; owner: string; reason: 'cover' | 'story' | 'story-missing' | 'studio' }>; unassigned: string[]; manifest?: string; dryRun: boolean };
type BackfillOptions = {
  dataDir: string; store: FlowStore;
  /** The owner id of a project, `undefined` when it does not exist (or has none). */
  ownerOfStory: (storyId: string) => Promise<string | undefined>;
  mainOwnerId: string | undefined;
  dryRun?: boolean; now?: () => Date;
};

const STORY_ID = /^story_[a-f0-9]{16}$/;
const TECHNIQUE_STORY = /^story:(story_[a-f0-9]{16})(?:\/|$)/;

export function storyIdOfJob(job: Pick<FlowJob, 'group' | 'technique'>): string | undefined {
  if (job.group && STORY_ID.test(job.group)) return job.group;
  return job.technique?.match(TECHNIQUE_STORY)?.[1];
}

const runs = new Map<string, Promise<unknown>>();

export function backfillJobOwners(options: BackfillOptions): Promise<JobBackfillReport> {
  const previous = runs.get(options.dataDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run(options));
  runs.set(options.dataDir, next);
  void next.finally(() => { if (runs.get(options.dataDir) === next) runs.delete(options.dataDir); }).catch(() => undefined);
  return next;
}

async function run(options: BackfillOptions): Promise<JobBackfillReport> {
  const { dataDir, store, mainOwnerId, dryRun = false } = options;
  const now = options.now ?? (() => new Date());
  const report: JobBackfillReport = { assigned: [], unassigned: [], dryRun };
  const jobs = await store.listJobs(Number.MAX_SAFE_INTEGER);
  const plan: Record<string, string> = {};
  const owners = new Map<string, string | undefined>();
  for (const job of jobs) {
    if (job.createdBy) continue;
    if (job.technique?.startsWith('cover:')) { plan[job.id] = SYSTEM_OWNER; report.assigned.push({ id: job.id, owner: SYSTEM_OWNER, reason: 'cover' }); continue; }
    const storyId = storyIdOfJob(job);
    if (storyId) {
      if (!owners.has(storyId)) owners.set(storyId, await options.ownerOfStory(storyId).catch(() => undefined));
      const owner = owners.get(storyId);
      if (owner) { plan[job.id] = owner; report.assigned.push({ id: job.id, owner, reason: 'story' }); continue; }
    }
    if (!mainOwnerId) { report.unassigned.push(job.id); continue; }
    plan[job.id] = mainOwnerId;
    report.assigned.push({ id: job.id, owner: mainOwnerId, reason: storyId ? 'story-missing' : 'studio' });
  }
  if (dryRun || report.assigned.length === 0) return report;

  const stamp = `${now().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`;
  const tenancy = join(dataDir, 'tenancy');
  const backup = join(`backup-${stamp}-jobs`, 'flow.json');
  const manifestFile = join(tenancy, 'migrations', `${stamp}-jobs.json`);
  await mkdir(join(tenancy, 'migrations'), { recursive: true, mode: 0o700 });
  await mkdir(join(tenancy, `backup-${stamp}-jobs`), { recursive: true, mode: 0o700 });
  const flowFile = join(dataDir, 'flow', 'flow.json');
  if (existsSync(flowFile)) await copyFile(flowFile, join(tenancy, backup));
  const header = { id: JOB_BACKFILL_ID, at: now().toISOString(), dataDir, backup };
  await writeManifest(manifestFile, { ...header, status: 'pending', planned: report.assigned.length, entries: [] });
  const done = await store.assignCreatedBy(plan);
  const doneIds = new Set(done.map(d => d.id));
  report.assigned = report.assigned.filter(a => doneIds.has(a.id));
  if (!done.length) { await rm(manifestFile, { force: true }); await rm(join(tenancy, `backup-${stamp}-jobs`), { recursive: true, force: true }); return report; }
  const reasons = new Map(report.assigned.map(a => [a.id, a.reason]));
  await writeManifest(manifestFile, { ...header, status: 'applied', entries: done.map(d => ({ id: d.id, field: 'createdBy', before: null, after: d.after, reason: reasons.get(d.id) })) });
  report.manifest = manifestFile;
  return report;
}

async function writeManifest(file: string, body: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
  await rename(tmp, file);
}

/** Remove exactly the owners the run added (a job somebody re-attributed since is left alone). The backup is kept. */
export async function rollbackJobBackfill(manifestPath: string, store: FlowStore): Promise<{ reverted: string[]; skipped: string[] }> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id: string; entries: Array<{ id: string; after: string }> };
  if (manifest.id !== JOB_BACKFILL_ID) throw new Error(`Manifest ${manifest.id} bukan ${JOB_BACKFILL_ID}`);
  const reverted = await store.clearCreatedBy(manifest.entries);
  const done = new Set(reverted);
  return { reverted, skipped: manifest.entries.map(e => e.id).filter(id => !done.has(id)) };
}

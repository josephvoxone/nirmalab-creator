/**
 * What the system admin may know about a project: METADATA only, taken from `story.json` through a whitelist
 * (id, owner, title, status, timestamps) plus the size of the project's folder. Nothing else of a project is ever opened here:
 * not `storyboard.json`, `assistant.json`, `dub.json`, snapshots, uploads or media (sizes come from `lstat`, never from reading a file).
 * The TITLE is only for projects without a living owner (orphans); `ownerSummary` has no title at all.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const STORY_ID = /^story_[a-f0-9]{16}$/;

export type ProjectMeta = {
  id: string;
  /** `createdBy` of story.json; undefined = never had an owner. */
  ownerId?: string;
  title: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Size of the project folder (sum of file sizes; a hard-linked clip counts in each folder that holds it). */
  bytes: number;
};
export type ProjectScan = { projects: ProjectMeta[]; unreadable: string[] };

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await folderBytes(path);
      else if (entry.isFile()) total += (await lstat(path)).size;
    } catch { /* vanished while scanning */ }
  }
  return total;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown, max = 300): string => (typeof value === 'string' ? value.slice(0, max) : '');

export async function scanProjects(dataDir: string, options: { withBytes?: boolean } = {}): Promise<ProjectScan> {
  const root = join(dataDir, 'stories');
  let names: string[];
  try { names = (await readdir(root)).filter(name => STORY_ID.test(name)).sort(); } catch { return { projects: [], unreadable: [] }; }
  const projects: ProjectMeta[] = [];
  const unreadable: string[] = [];
  for (const id of names) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, id, 'story.json'), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      record = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(id);
      continue;
    }
    const owner = str(record.createdBy, 120);
    projects.push({
      id, ...(owner ? { ownerId: owner } : {}), title: str(record.title), status: str(record.status, 40) || 'draft',
      createdAtMs: num(record.createdAtMs), updatedAtMs: num(record.updatedAtMs),
      bytes: options.withBytes === false ? 0 : await folderBytes(join(root, id))
    });
  }
  return { projects, unreadable };
}

/** A project is an orphan when no living account owns it (the owner was removed, or it never had one). */
export const isOrphan = (project: ProjectMeta, liveUserIds: ReadonlySet<string>): boolean => !project.ownerId || !liveUserIds.has(project.ownerId);

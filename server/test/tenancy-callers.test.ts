/**
 * T3 §4 — no path around the gate (audit 06 §E.1 last row, static). Every direct reader of project files / records outside the
 * StoryService itself is pinned here. A new call site fails this test on purpose: route it through `assertOwner` / `listFor` (or put it
 * behind a registry route, which the HTTP gate covers) and only then raise the number, with the reason in the commit.
 *
 * Why the numbers are what they are:
 *   stories/routes.ts, dub/routes.ts, assistant/routes.ts   run only AFTER the onRequest gate (tenancy/ownership.ts) let the owner through;
 *   assistant/actions.ts, assistant/chat.ts, mcp/server.ts   run behind assertOwner (guarded / assertProjectOwner / findStory);
 *   app.ts                                                   publisher callbacks (behind the gate + canAccessStory), the dub service wiring
 *                                                            (system), and the boot-time dub resume (system, `list`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
});
const RAW = /\bstories\.(get|list|readStoryboard|storyDir|videoPath|framePath|castPath|shotPath|musicPath)\(/g;

const counts = (): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    if (rel === join('stories', 'service.ts')) continue;
    const found: Record<string, number> = {};
    for (const m of readFileSync(file, 'utf8').matchAll(RAW)) found[m[1]!] = (found[m[1]!] ?? 0) + 1;
    if (Object.keys(found).length) out[rel] = found;
  }
  return out;
};

const PINNED: Record<string, Record<string, number>> = {
  'app.ts': { get: 3, videoPath: 1, readStoryboard: 2, storyDir: 1, list: 1 },
  'assistant/actions.ts': { readStoryboard: 8, get: 3, storyDir: 3, framePath: 1, castPath: 1 },
  'assistant/chat.ts': { get: 1, storyDir: 6, readStoryboard: 3 },
  'assistant/routes.ts': { get: 4, storyDir: 2 },
  'dub/routes.ts': { readStoryboard: 1 },
  'mcp/server.ts': { storyDir: 2, get: 1 },
  'stories/routes.ts': { get: 18, readStoryboard: 4, framePath: 1, castPath: 1, storyDir: 2, musicPath: 1, videoPath: 2, shotPath: 2 }
};

describe('T3 no path around the gate (static)', () => {
  it('every direct reader of project records/files outside StoryService is pinned: a new one must be reviewed', () => {
    expect(counts()).toEqual(PINNED);
  });

  it('the unbounded list() is used by the system only (boot dub resume): never by a route, the assistant or MCP', () => {
    const users = Object.entries(counts()).filter(([, c]) => c.list).map(([f]) => f);
    expect(users).toEqual(['app.ts']);
  });

  it('the service layers keep their own workspace-role check (assertAccess / listFor, never createdBy)', () => {
    const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
    expect(read('assistant/actions.ts')).toMatch(/ctx\.stories\.assertAccess\(storyId, ctx\.userId, min\)/);
    expect((read('assistant/chat.ts').match(/assertProjectEditor\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(read('assistant/chat.ts')).toMatch(/stories\.assertAccess\(storyId, userId, 'editor'\)/);
    expect(read('mcp/server.ts')).toMatch(/stories\.assertAccess\(id, userId, min\)/);
    expect(read('mcp/server.ts')).toMatch(/stories\.listFor\(caller\.userId\)/);
    expect(read('stories/routes.ts')).toMatch(/stories\.listFor\(user\.id, workspace\)/);
    // WAVE 4: the gate decides by ROLE in the project's workspace, and a viewer never writes.
    const gate = read('tenancy/ownership.ts');
    expect(gate).toMatch(/deps\.stories\(\)\.roleFor\(id, userId\)/);
    expect(gate).toMatch(/isWrite\(request\) && !canEdit\(role\)/);
    expect(gate).toMatch(/VIEWER_READ_ONLY_BODY/);
  });

  it('the owner axis is the workspace: a project access decision never compares `createdBy`, and only the known files mention it', () => {
    // `createdBy` stays as HISTORY and as the attribution of things that are not in a project (Flow jobs, Studio, invites,
    // quota ledger rows). Anything else must decide by workspaceRole. A new file here needs a review.
    const PINNED = [
      'app.ts', 'auth/routes.ts', 'auth/store.ts', 'flow/backfill.ts', 'flow/job-access.ts', 'flow/routes.ts', 'flow/store.ts',
      'mcp/server.ts', 'providers/axcel.ts', 'publisher/owner.ts', 'quota/gates.ts',
      'stories/routes.ts', 'stories/service.ts', 'tenancy/admin-routes.ts', 'tenancy/migrate.ts', 'tenancy/project-meta.ts',
      'tenancy/ownership.ts', 'tenancy/workspace-role.ts', 'trends/routes.ts',
      // wave 4: workspace/migrate maps old projects by their creator (the boot migration), workspace/store records WHO
      // INVITED a member, workspace/routes passes that id through, workspace/service names the inviter. Attribution only:
      // no project access decision compares it (the assertions below hold).
      'workspace/migrate.ts', 'workspace/store.ts', 'workspace/routes.ts', 'workspace/service.ts'
    ].map(r => join(...r.split('/')));
    const users: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (rel.endsWith('.test.ts')) continue;
      if (/\bcreatedBy\b/.test(readFileSync(file, 'utf8'))) users.push(rel);
    }
    expect(users.sort()).toEqual(PINNED.sort());

    // The project gate has no `ownerOf`/`createdBy` comparison at all: roleFor is the only key to a project.
    const gate = readFileSync(join(SRC, 'tenancy', 'ownership.ts'), 'utf8');
    expect(gate).not.toMatch(/ownerOf\(/);
    // And the service decides access through the workspace store, not through the creator.
    const service = readFileSync(join(SRC, 'stories', 'service.ts'), 'utf8');
    const assertAccess = service.slice(service.indexOf('async assertAccess('), service.indexOf('/** Kept for the tenancy hotfixes'));
    expect(assertAccess).toMatch(/this\.roleFor\(id, userId\)/);
    expect(assertAccess).not.toMatch(/createdBy/);
  });

  it('every direct reader of story.json outside StoryService is a known system reader (a new one must go through the service)', () => {
    // Why each is allowed: snapshots = undo, under the service lock and reachable only through StoryService;
    // project-meta / admin-routes = the SYSTEM admin's metadata whitelist (never content); storage = sizes on disk;
    // migrate = the boot migration that gives old projects their owner/workspace.
    // workspace/migrate.ts = the boot migration that gives every project its workspace;
    // workspace/service.ts = project COUNTS per workspace, reading only `workspaceId` (never a title or any content).
    const ALLOWED = ['stories/snapshots.ts', 'tenancy/project-meta.ts', 'tenancy/admin-routes.ts', 'media/storage.ts', 'tenancy/migrate.ts', 'workspace/migrate.ts', 'workspace/service.ts'];
    const readers: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join('stories', 'service.ts')) continue;
      if (/\bstory\.json\b/.test(readFileSync(file, 'utf8'))) readers.push(rel);
    }
    expect(readers.sort()).toEqual(ALLOWED.map(r => join(...r.split('/'))).sort());
  });
});

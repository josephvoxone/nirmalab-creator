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
  'app.ts': { get: 4, videoPath: 1, readStoryboard: 2, storyDir: 1, list: 1 },
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

  it('the service layers keep their own owner check (assertOwner / listFor / assertProjectOwner)', () => {
    const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
    expect(read('assistant/actions.ts')).toMatch(/ctx\.stories\.assertOwner\(storyId, ctx\.userId\)/);
    expect((read('assistant/chat.ts').match(/assertProjectOwner\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(read('mcp/server.ts')).toMatch(/stories\.assertOwner\(id, userId\)/);
    expect(read('mcp/server.ts')).toMatch(/stories\.listFor\(caller\.userId\)/);
    expect(read('stories/routes.ts')).toMatch(/stories\.listFor\(user\.id\)/);
  });

  it('the gate is installed in app.ts before any scope is registered (hooks of the root are inherited only by later scopes)', () => {
    const app = readFileSync(join(SRC, 'app.ts'), 'utf8');
    const gate = app.indexOf('installOwnershipGate(server');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(app.indexOf('await server.register('));
    expect(gate).toBeLessThan(app.indexOf('registerStoryRoutes('));
    expect(gate).toBeGreaterThan(app.indexOf('registerCrossSiteGuard('));
  });
});

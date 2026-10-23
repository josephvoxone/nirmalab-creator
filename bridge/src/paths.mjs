/**
 * One home for every Flow file: ~/Documents/nirmalab/flow (override with FLOW_HOME).
 *   stories/<slug>/storyboard.json + shots + final video
 *   bridge/   Studio job clips      exports/  loose MCP downloads      logs/
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const flowHome = (env = process.env) => env.FLOW_HOME || join(homedir(), 'Documents', 'nirmalab', 'flow');

const isPath = s => s.includes('/') || s.endsWith('.json');

export const storyDir = (slug, env = process.env) => join(flowHome(env), 'stories', slug);

export const storyFile = (slugOrPath, env = process.env) =>
  isPath(slugOrPath) ? slugOrPath : join(storyDir(slugOrPath, env), 'storyboard.json');

export const expandPath = (p, env = process.env) =>
  p.replace(/^\$FLOW_HOME(?=\/|$)/, flowHome(env)).replace(/^~(?=\/|$)/, homedir());

/**
 * Remote MCP server (spec 2 goal 9, 6.5, 9.7): Streamable HTTP at `/mcp`, stateless — a fresh
 * McpServer + transport per POST, authenticated only by a personal access token
 * (`Authorization: Bearer nc_…`, see tokens.ts). GET/DELETE answer 405 (no sessions, no SSE stream).
 *
 * Tools = `list_projects`, `create_project` and every action of the shared action layer (the same
 * code the in-app chat runs), each with a required `project_id`. Spending tools take the client's
 * own `confirm: true` (the MCP client's approval UI is the gate) plus the required `rev` of the cost answer.
 * Every mutating call is logged in that project's assistant history as `MCP · <token name>` with
 * the same Batalkan chip as the chat. Results are JSON text; errors are `isError` + plain message.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_NAMES, ACTIONS, CHAT_CONFIRM_RULE, runAction, undoTarget, type ActionContext, type ActionName, type ActionResult } from '../assistant/actions.js';
import { appendTurn, markUndone } from '../assistant/history.js';
import { listSkills } from '../assistant/skills.js';
import type { TextModel } from '../llm/opencode.js';
import { DraftError, draftStoryboard, type TextGenerator } from '../stories/draft.js';
import { CATALOG } from '../stories/looks.js';
import { QuotaError } from '../quota/errors.js';
import { StoryError, type StoryRecord, type StoryService } from '../stories/service.js';
import type { McpTokenStore } from './tokens.js';

export const STALE_REV_MESSAGE = 'Proyek sudah berubah — cek biaya lagi';
export const RATE_LIMIT_MESSAGE = 'Terlalu banyak permintaan';
export const RATE_LIMIT_PER_MINUTE = 60;
export const BATCH_MESSAGE = 'Batch tidak didukung';
export const CREATE_BUSY_MESSAGE = 'Masih membuat proyek — tunggu selesai';
const MCP_BODY_LIMIT = 1024 * 1024;

export const MCP_INSTRUCTIONS = [
  'Nirmalab Creator makes short films: a project (Proyek) has scenes, each scene has shots.',
  'Start with list_projects (or create_project), then get_project {project_id} to read the numbered scenes and shots.',
  'Address shots and scenes by the numbers get_project shows (shot 1..N counted across all scenes, scene 1..M), never by guessing ids.',
  'Describe intent, not prompt text: on bible projects edit subject, action, startState, endState, emotion, framing, move and narration; the app compiles the image/video prompt itself.',
  'Spending tools (make_sheet, redraw_frame, prepare, render, assemble) use Flow credits or OpenRouter money. Call them once WITHOUT confirm: the answer is {needsConfirm, label, estimate, rev}. Show that cost to the user. Only after the user agrees, call again with the same arguments plus confirm: true and that rev. Never set confirm on your own.',
  'Every change appears in the project chat inside the app with an undo button; undo_last reverts the newest change.',
  'Labels and errors are in Indonesian: pass them on to the user as they are.',
  'Rules for good shots, continuity, copy and hooks are resources shotweave://skills/<name>; read them before writing intent or narration.'
].join('\n');

export type McpDeps = {
  stories: StoryService;
  tokens: McpTokenStore;
  generateText: TextGenerator;
  textModel?: TextModel;
  price?: ActionContext['price'];
  version?: string;
  /** Keys (token ids) with a create_project in flight: one at a time per token. */
  creating?: Set<string>;
};

/** Who is calling: the token owner, and the name shown in the project chat (`tokenId` on /mcp). */
export type McpCaller = { userId: string; email: string; by: string; tokenId?: string };

const READ_ONLY = new Set<string>(['get_project', 'list_projects']);
const SPENDING_NOTE = ' Spends credits or money: call once WITHOUT confirm to get the cost (needsConfirm, label, estimate, rev), show it to the user, and call again with the same arguments plus confirm: true and rev only after they agree.';

type JsonSchema = { type: 'object'; properties?: Record<string, object>; required?: string[]; [key: string]: unknown };

/** The tool list: list/create, then every action with `project_id` (+ `confirm`/`rev` on spending tools). */
export function mcpTools(): Tool[] {
  const tools: Tool[] = [
    {
      name: 'list_projects',
      description: 'List your own projects (newest first): project_id, title, status, number of shots, last update. Use a project_id from here in the other tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'create_project',
      description: 'Create a new project from a premise (the app drafts a storyboard with the configured text model, which can take a minute; nothing is rendered). Returns project_id and title; then call get_project.',
      inputSchema: {
        type: 'object',
        properties: {
          premise: { type: 'string', minLength: 5, maxLength: 2000, description: 'What the story is about, in a sentence or two (Indonesian is fine).' },
          template: { type: 'string', enum: CATALOG.templates.map(t => t.id), description: 'Optional template id (look, pace, narrator).' },
          aspect: { type: 'string', enum: ['9:16', '16:9'], description: 'Optional aspect ratio; default from the template or 9:16.' }
        },
        required: ['premise'],
        additionalProperties: false
      }
    }
  ];
  for (const name of ACTION_NAMES) {
    const action = ACTIONS[name];
    const schema = action.schema as JsonSchema;
    const properties: Record<string, object> = {
      project_id: { type: 'string', description: 'Project id from list_projects.' },
      ...(schema.properties ?? {}),
      ...(action.spends ? {
        confirm: { type: 'boolean', description: 'true only after the user agreed to the cost from the previous call.' },
        rev: { type: 'integer', description: 'The rev returned with the cost; required with confirm. The call is refused if the project changed since.' }
      } : {})
    };
    tools.push({
      name,
      // The chat's confirm sentence ("you cannot confirm it yourself") is wrong here: the MCP client confirms.
      description: action.spends ? `${action.description.replace(CHAT_CONFIRM_RULE, '').trim()}${SPENDING_NOTE}` : action.description,
      inputSchema: { ...schema, type: 'object', properties, required: ['project_id', ...(schema.required ?? [])] },
      ...(READ_ONLY.has(name) ? { annotations: { readOnlyHint: true } } : {})
    });
  }
  return tools;
}

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {})
});
const failure = (message: string) => text(message, true);

/**
 * The project when the token's user may act on it in its workspace. `editor` for anything that changes the project, `viewer`
 * for a read: somebody else's (or a workspace they are not a member of) looks exactly like a missing one.
 */
async function findStory(stories: StoryService, id: unknown, userId: string, min: 'viewer' | 'editor' = 'editor'): Promise<StoryRecord | undefined> {
  if (typeof id !== 'string' || !id) return undefined;
  try { return await stories.assertAccess(id, userId, min); } catch (error) { if (error instanceof StoryError && error.code === 'NOT_FOUND') return undefined; throw error; }
}

async function listProjects(deps: McpDeps, caller: McpCaller): Promise<CallToolResult> {
  const records = await deps.stories.listFor(caller.userId);
  return text(records.map(r => ({ project_id: r.id, title: r.title, status: r.status, shots: r.shots.length, updatedAt: new Date(r.updatedAtMs).toISOString() })));
}

/** Same path as `POST /api/stories/draft`: draftStoryboard with the app's text generator, then create. */
async function createProject(deps: McpDeps, caller: McpCaller, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  const premise = typeof args.premise === 'string' ? args.premise.trim() : '';
  if (premise.length < 5) return failure('Tulis premis cerita (min. 5 karakter)');
  const template = args.template ?? undefined;
  if (template !== undefined && (typeof template !== 'string' || !CATALOG.templates.some(t => t.id === template))) {
    return failure(`Template "${String(template).slice(0, 40)}" tidak ada — lihat daftar di skema tool.`);
  }
  const aspect = args.aspect ?? undefined;
  if (aspect !== undefined && aspect !== '9:16' && aspect !== '16:9') return failure('aspect harus "9:16" atau "16:9"');
  const key = caller.tokenId ?? caller.userId;
  if (deps.creating?.has(key)) return failure(CREATE_BUSY_MESSAGE);
  deps.creating?.add(key);
  try {
    const board = await draftStoryboard({
      premise: premise.slice(0, 2000),
      ...(template ? { template: template as string } : {}),
      ...(aspect ? { aspect: aspect as '9:16' | '16:9' } : {})
    }, deps.generateText, signal ? { signal } : {});
    if (signal?.aborted) return failure('Dibatalkan.');
    const story = await deps.stories.create(board, { createdBy: caller.userId });
    await appendTurn(deps.stories.storyDir(story.id), { role: 'assistant', text: `Proyek dibuat: ${story.title}`, source: 'mcp', by: caller.by });
    return text({ project_id: story.id, title: story.title });
  } catch (error) {
    // Same plain message as POST /api/stories/draft; the detail only goes to the log.
    if (error instanceof DraftError) return failure(error.plain);
    throw error;
  } finally {
    deps.creating?.delete(key);
  }
}

async function runActionTool(deps: McpDeps, caller: McpCaller, name: ActionName, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  // Reading (get_project) is open to a viewer of the workspace; every action tool needs owner/editor.
  const record = await findStory(deps.stories, args.project_id, caller.userId, READ_ONLY.has(name) ? 'viewer' : 'editor');
  if (!record) return failure(typeof args.project_id === 'string' && args.project_id ? 'Proyek tidak ditemukan — cek project_id dari list_projects.' : 'project_id wajib diisi (dari list_projects).');
  const storyId = record.id;
  const action = ACTIONS[name];
  const { project_id: _project, confirm, rev, ...input } = args;

  // The client's own approval: only the boolean true counts, and only on a spending tool.
  const confirmed = action.spends && confirm === true;
  let pinned: number | undefined;
  // The approval is for the cost the user saw, and that cost was answered with a rev.
  if (confirmed && (rev === undefined || rev === null)) return failure('Sertakan rev dari jawaban biaya');
  if (confirmed) {
    if (typeof rev !== 'number' || !Number.isInteger(rev)) return failure('rev harus angka dari jawaban biaya sebelumnya');
    if (rev !== record.rev) return failure(STALE_REV_MESSAGE);
    pinned = rev;
  }
  const ctx: ActionContext = {
    stories: deps.stories, snapshots: deps.stories.snapshots, userId: caller.userId, source: 'mcp', turn: {},
    ...(deps.textModel ? { model: deps.textModel } : {}), ...(deps.price ? { price: deps.price } : {}),
    ...(confirmed ? { confirmed: true } : {}),
    ...(pinned !== undefined ? { rev: pinned } : {}),
    ...(signal ? { signal } : {})
  };
  const undone = await undoTarget(deps.stories, storyId, name);
  const result: ActionResult = await runAction(ctx, storyId, name, input);
  const currentRev = async () => (await deps.stories.get(storyId).catch(() => undefined))?.rev ?? record.rev;

  if ('needsConfirm' in result) {
    return text({
      needsConfirm: true, label: result.label, estimate: result.estimate, rev: await currentRev(),
      next: 'Show this cost to the user. Only after they agree, call again with the same arguments plus confirm: true and this rev.'
    });
  }
  if (!result.ok) return failure(result.code === 'STALE' && pinned !== undefined ? STALE_REV_MESSAGE : result.error);

  if (!READ_ONLY.has(name) && result.changed !== false) {
    const dir = deps.stories.storyDir(storyId);
    if (undone) await markUndone(dir, undone);
    const undoId = ctx.turn.undoId;
    await appendTurn(dir, {
      role: 'assistant', text: result.label, source: 'mcp', by: caller.by,
      ...(undoId ? { changes: [{ label: result.label, undoId }] } : {})
    });
  }
  return text({
    ok: true, label: result.label, changed: result.changed ?? !READ_ONLY.has(name), rev: await currentRev(),
    ...(result.data !== undefined ? { data: result.data } : {})
  });
}

/** One MCP server for one caller (a request, or the in-process Tes koneksi). */
export function createMcpServer(deps: McpDeps, caller: McpCaller, log?: FastifyBaseLogger): McpServer {
  const mcp = new McpServer(
    { name: 'nirmalab-creator', version: deps.version ?? 'dev' },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
  );
  const tools = mcpTools();
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const raw = request.params.arguments ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return failure('Argumen harus objek JSON.');
    const args = raw as Record<string, unknown>;
    try {
      if (name === 'list_projects') return await listProjects(deps, caller);
      if (name === 'create_project') return await createProject(deps, caller, args, extra.signal);
      if ((ACTION_NAMES as readonly string[]).includes(name)) return await runActionTool(deps, caller, name as ActionName, args, extra.signal);
      return failure(`Tool "${name.slice(0, 40)}" tidak ada.`);
    } catch (error) {
      if (error instanceof StoryError || error instanceof QuotaError) return failure(error.message);
      log?.warn({ err: error, tool: name }, 'mcp tool failed');
      return failure('Gagal menjalankan tool — coba lagi.');
    }
  });

  for (const skill of listSkills()) {
    const uri = `shotweave://skills/${skill.name}`;
    mcp.registerResource(skill.name, uri, { title: skill.title, description: `Nirmalab skill: ${skill.title}`, mimeType: 'text/markdown' },
      async () => ({ contents: [{ uri, mimeType: 'text/markdown', text: skill.text }] }));
  }
  mcp.registerPrompt('nirmalab_guide', { title: 'How to work with Nirmalab Creator', description: 'Shot numbers, intent instead of prompt text, and the confirm flow for spending.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: MCP_INSTRUCTIONS } }] }));
  return mcp;
}

// ------------------------------------------------------------------ HTTP endpoint

const rpcError = (reply: FastifyReply, status: number, code: number, message: string, id: unknown = null) =>
  reply.code(status).header('content-type', 'application/json').send({ jsonrpc: '2.0', error: { code, message }, id });

/** In-memory sliding window per token. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit = RATE_LIMIT_PER_MINUTE, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const bearer = (request: FastifyRequest) => /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '')?.[1];

/** `POST /mcp` (bearer token only — no session cookie, no CSRF), `GET|DELETE /mcp` → 405. */
export function registerMcpEndpoint(server: FastifyInstance, baseDeps: McpDeps): void {
  const limiter = new RateLimiter();
  const deps: McpDeps = { ...baseDeps, creating: baseDeps.creating ?? new Set<string>() };
  const callers = new WeakMap<FastifyRequest, McpCaller & { tokenId: string }>();

  server.post('/mcp', {
    bodyLimit: MCP_BODY_LIMIT,
    // Authenticate before the body is read.
    onRequest: async (request, reply) => {
      const verified = await deps.tokens.verify(bearer(request));
      if (!verified) {
        reply.header('www-authenticate', 'Bearer realm="nirmalab-creator"');
        return rpcError(reply, 401, -32001, 'Unauthorized: token tidak valid atau sudah dicabut');
      }
      callers.set(request, { userId: verified.user.id, email: verified.user.email, by: verified.token.name, tokenId: verified.token.id });
      return undefined;
    }
  }, async (request, reply) => {
    const caller = callers.get(request)!;
    const body = request.body as { id?: unknown } | unknown[] | undefined;
    // JSON-RPC batches (dropped from current MCP protocol versions) would run N calls on one rate-limit hit.
    if (Array.isArray(body)) return rpcError(reply, 400, -32600, BATCH_MESSAGE);
    if (!limiter.take(caller.tokenId)) {
      return rpcError(reply, 429, -32000, RATE_LIMIT_MESSAGE, body && !Array.isArray(body) && typeof body === 'object' ? (body.id ?? null) : null);
    }
    reply.hijack();
    const res = reply.raw;
    res.setHeader('x-content-type-options', 'nosniff');
    const mcp = createMcpServer(deps, caller, request.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close().catch(() => undefined); void mcp.close().catch(() => undefined); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request.raw, res, request.body);
    } catch (error) {
      request.log.warn({ err: error }, 'mcp request failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      } else if (!res.writableEnded) res.end();
    }
  });

  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('allow', 'POST');
    return rpcError(reply, 405, -32000, 'Method not allowed.');
  };
  server.get('/mcp', notAllowed);
  server.delete('/mcp', notAllowed);
}

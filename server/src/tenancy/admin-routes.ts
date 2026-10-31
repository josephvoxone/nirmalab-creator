/**
 * System admin console (audit 06 §A.3, T8). EVERY route here is SISTEM-ADMIN and none reads the content of a project:
 *  - usage per owner = counts and bytes, no title, no id of a live project;
 *  - the ONLY project metadata with a title is the orphan list (no living owner), the admin may move or delete those;
 *  - project files other than `story.json` (storyboard, assistant, dub, media) are never opened — sizes come from `lstat`.
 * Each change is written to the admin trail (`tenancy/audit-log.ts`): who, what, when, target; no content.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import { MemberError, type UserAuthStore } from '../auth/store.js';
import type { FlowStore } from '../flow/store.js';
import { QUOTA_KINDS, LimitInputError, parseUserLimits, type LimitsStore } from '../quota/limits.js';
import type { SpendLedger } from '../quota/ledger.js';
import { limitsView } from '../quota/routes.js';
import type { AdminAuditLog } from './audit-log.js';
import { writeFileAtomic } from './migrate.js';
import { STORY_ID, isOrphan, scanProjects, type ProjectMeta } from './project-meta.js';

export type AdminRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: Pick<FlowStore, 'reassignGroup'>;
  ledger: SpendLedger;
  limits: LimitsStore;
  audit: AdminAuditLog;
  /** The story's mutation lock (`StoryService.lockStory`): a transfer/delete never interleaves with the service's own writes. */
  lock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /** Called after a change that moved bytes or owners (drops the cached storage figure). */
  onChange?: () => void;
};

const err = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const USER_ID = /^[A-Za-z0-9_-]{1,80}$/;

export async function registerAdminRoutes(server: FastifyInstance, options: AdminRouteOptions): Promise<void> {
  const { userAuthStore: auth, dataDir, audit, limits, ledger } = options;
  const view = limitsView(auth, ledger, limits);
  const record = (entry: Parameters<AdminAuditLog['append']>[0]) => audit.append(entry).catch(() => undefined);
  const live = () => new Set(auth.listUsers().map(user => user.id));
  const emailOfOwner = (id: string | undefined): string | null => (id ? auth.findUserById(id)?.email ?? auth.findTombstone(id)?.email ?? null : null);

  server.get('/api/admin/projects', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const { projects, unreadable } = await scanProjects(dataDir);
    const alive = live();
    const members = auth.listUsers();
    const owners = members.map(member => {
      const mine = projects.filter(project => project.ownerId === member.id);
      return {
        userId: member.id, email: member.email, isAdmin: member.isAdmin, ...(member.suspendedAt ? { suspendedAt: member.suspendedAt } : {}),
        projects: mine.length, bytes: mine.reduce((n, project) => n + project.bytes, 0),
        lastActivityMs: mine.length ? Math.max(...mine.map(project => project.updatedAtMs)) : null
      };
    });
    const orphans = projects.filter(project => isOrphan(project, alive)).map(project => ({
      id: project.id, title: project.title, ownerId: project.ownerId ?? null, ownerEmail: emailOfOwner(project.ownerId),
      bytes: project.bytes, createdAtMs: project.createdAtMs, updatedAtMs: project.updatedAtMs, status: project.status
    }));
    return {
      owners, orphans,
      totals: { projects: projects.length, bytes: projects.reduce((n, project) => n + project.bytes, 0), orphans: orphans.length, orphanBytes: orphans.reduce((n, o) => n + o.bytes, 0), unreadable: unreadable.length }
    };
  });

  /** The project when it is an orphan, else the reason. Reads only story.json (through the whitelist). */
  async function orphanOf(id: string): Promise<{ project: ProjectMeta } | { status: number; code: string; message: string }> {
    if (!STORY_ID.test(id)) return { status: 404, code: 'NOT_FOUND', message: 'Proyek tidak ditemukan' };
    const { projects } = await scanProjects(dataDir, { withBytes: false });
    const project = projects.find(entry => entry.id === id);
    if (!project) return { status: 404, code: 'NOT_FOUND', message: 'Proyek tidak ditemukan' };
    if (!isOrphan(project, live())) return { status: 409, code: 'BUKAN_YATIM', message: 'Proyek ini masih punya pemilik. Pengelola hanya boleh memindahkan atau menghapus proyek yatim.' };
    return { project };
  }

  server.post<{ Params: { id: string }; Body: { toUserId?: unknown } | undefined }>('/api/admin/projects/:id/transfer', async (request, reply) => {
    const admin = requireAdmin(auth, request, reply);
    if (!admin) return undefined;
    const toUserId = typeof request.body?.toUserId === 'string' ? request.body.toUserId : '';
    if (!USER_ID.test(toUserId)) return err(reply, 400, 'INVALID_INPUT', 'Pilih pengguna tujuan');
    const id = request.params.id;
    const pre = await orphanOf(id);
    if ('status' in pre) return err(reply, pre.status, pre.code, pre.message);
    const target = auth.findUserById(toUserId);
    if (!target) return err(reply, 404, 'PENGGUNA_TIDAK_ADA', 'Pengguna tujuan tidak ditemukan');
    if (target.suspendedAt) return err(reply, 409, 'AKUN_DITANGGUHKAN', 'Pengguna tujuan sedang ditangguhkan. Aktifkan dulu, atau pilih pengguna lain.');
    const outcome = await options.lock(id, async () => {
      // Re-read under the lock: somebody may have moved it meanwhile.
      const check = await orphanOf(id);
      if ('status' in check) return check;
      const file = join(dataDir, 'stories', id, 'story.json');
      const current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const previous = typeof current.createdBy === 'string' && current.createdBy ? current.createdBy : undefined;
      const next = { ...current, createdBy: toUserId, ...(previous ? { transferredFrom: previous } : {}), transferredAt: new Date().toISOString(), transferredBy: admin.id };
      await writeFileAtomic(file, JSON.stringify(next, null, 1));
      return { ok: true as const, previous };
    });
    if ('status' in outcome) return err(reply, outcome.status, outcome.code, outcome.message);
    const jobsReassigned = await options.flow.reassignGroup(id, toUserId);
    await record({ by: admin.id, action: 'yatim.pindah', targetId: id, targetEmail: target.email, detail: { toUserId, fromUserId: outcome.previous ?? null, jobsReassigned } });
    options.onChange?.();
    return { ok: true, id, toUserId, jobsReassigned };
  });

  server.delete<{ Params: { id: string }; Body: { confirmTitle?: unknown } | undefined }>('/api/admin/projects/:id', async (request, reply) => {
    const admin = requireAdmin(auth, request, reply);
    if (!admin) return undefined;
    const id = request.params.id;
    const pre = await orphanOf(id);
    if ('status' in pre) return err(reply, pre.status, pre.code, pre.message);
    const typed = request.body?.confirmTitle;
    if (typeof typed !== 'string' || typed !== pre.project.title) {
      return err(reply, 400, 'KONFIRMASI_SALAH', 'Ketik judul proyek persis seperti tertulis untuk menghapusnya.');
    }
    const outcome = await options.lock(id, async () => {
      const check = await orphanOf(id);
      if ('status' in check) return check;
      const { projects } = await scanProjects(dataDir);
      const project = projects.find(entry => entry.id === id) ?? check.project;
      // The grave is written BEFORE anything is removed: nothing disappears without a line saying who, what and how big.
      await record({ by: admin.id, action: 'yatim.hapus', targetId: id, detail: { title: project.title, ownerEmail: emailOfOwner(project.ownerId), bytes: project.bytes } });
      await rm(join(dataDir, 'stories', id), { recursive: true, force: true });
      return { ok: true as const, bytes: project.bytes };
    });
    if ('status' in outcome) return err(reply, outcome.status, outcome.code, outcome.message);
    options.onChange?.();
    return { ok: true, id, freedBytes: outcome.bytes };
  });

  const setSuspended = (suspended: boolean) => async (request: { params: { id: string } } & Parameters<typeof requireAdmin>[1], reply: FastifyReply) => {
    const admin = requireAdmin(auth, request, reply);
    if (!admin) return undefined;
    try {
      const was = auth.findUserById(request.params.id)?.suspendedAt;
      const member = auth.setSuspended(request.params.id, suspended, admin.id);
      if (Boolean(was) !== suspended) await record({ by: admin.id, action: suspended ? 'anggota.tangguhkan' : 'anggota.aktifkan', targetId: member.id, targetEmail: member.email });
      return { member };
    } catch (error) {
      if (!(error instanceof MemberError)) throw error;
      const text = error.code === 'SELF' ? 'Anda tidak bisa menangguhkan akun Anda sendiri.' : error.code === 'LAST_ADMIN' ? 'Harus ada setidaknya satu pengelola yang aktif.' : 'Pengguna tidak ditemukan';
      return err(reply, error.code === 'NOT_FOUND' ? 404 : 409, error.code, text);
    }
  };
  server.post<{ Params: { id: string } }>('/api/admin/users/:id/suspend', setSuspended(true));
  server.post<{ Params: { id: string } }>('/api/admin/users/:id/activate', setSuspended(false));

  server.get<{ Params: { id: string } }>('/api/admin/users/:id/limits', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = USER_ID.test(request.params.id) ? await view(request.params.id) : undefined;
    return body ?? err(reply, 404, 'NOT_FOUND', 'Pengguna tidak ditemukan');
  });

  server.put<{ Params: { id: string }; Body: { limits?: unknown } | undefined }>('/api/admin/users/:id/limits', async (request, reply) => {
    const admin = requireAdmin(auth, request, reply);
    if (!admin) return undefined;
    const user = USER_ID.test(request.params.id) ? auth.findUserById(request.params.id) : undefined;
    if (!user) return err(reply, 404, 'NOT_FOUND', 'Pengguna tidak ditemukan');
    let parsed;
    try { parsed = parseUserLimits(request.body?.limits ?? {}); } catch (error) {
      if (error instanceof LimitInputError) return err(reply, 400, 'INVALID_INPUT', error.message);
      throw error;
    }
    await limits.set(user.id, parsed);
    await record({ by: admin.id, action: 'batas.ubah', targetId: user.id, targetEmail: user.email, detail: { kinds: Object.keys(parsed).join(',') } });
    return view(user.id);
  });

  server.get<{ Querystring: { days?: string } }>('/api/admin/usage', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const days = Math.min(62, Math.max(1, Math.floor(Number(request.query.days ?? 7)) || 7));
    const rows = new Map((await ledger.summary(days)).map(row => [row.userId, row] as const));
    // Every live user, zeros included; spend of removed accounts stays in the ledger but is not listed.
    const users = auth.listUsers().map(member => ({
      userId: member.id, email: member.email,
      ...Object.fromEntries(QUOTA_KINDS.map(kind => [kind, rows.get(member.id)?.[kind] ?? 0]))
    }));
    return { days, users };
  });

  server.get<{ Querystring: { limit?: string } }>('/api/admin/audit-log', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return { entries: await audit.list(Number(request.query.limit ?? 100)) };
  });
}

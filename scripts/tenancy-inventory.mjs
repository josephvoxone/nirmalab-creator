#!/usr/bin/env node
// Tenancy inventory (audit 06 §C.1): what is in /data, who owns it, and what `ensureOwners` would do at the next boot.
//   node scripts/tenancy-inventory.mjs [/data] [--json] [--no-size] [--owner-email=you@x.io]
// In the container (the image does not ship scripts/): docker exec -i <container> node - /data < scripts/tenancy-inventory.mjs
//
// READ-ONLY: this file only reads (readFileSync / readdirSync / lstatSync); it never writes, renames or deletes anything, and creates
// no files. Safe to run against production while the app is running.
// PRIVACY: it prints counts, ids, member emails/roles and byte sizes. It never prints a project title, prompt, narration, token or
// secret — the one exception is the TITLE of an ORPHAN (a project whose owner no longer exists), which is what an admin may see.
// Hard-linked media counts once. `--no-size` skips the byte walk (huge volumes).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataDir = argv.find(a => !a.startsWith('--')) || process.env.OPENCREATOR_DATA_DIR || process.env.DATA_DIR || '/data';
const wantSize = !flag('no-size');
const asJson = flag('json');
const STORY_ID = /^story_[a-f0-9]{16}$/;
const QA_EMAIL = /^qa-/i;
const problems = [];

const readJson = (file, label) => {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { problems.push(`${label} tidak terbaca (JSON rusak)`); return undefined; }
};
const normalize = email => String(email).trim().toLowerCase();

if (!existsSync(dataDir)) problems.push(`Folder data tidak ditemukan: ${dataDir}`);

// --- members (auth.json): id, email, role only; password hashes and sessions are never touched.
const auth = readJson(join(dataDir, 'auth.json'), 'auth.json');
const users = (auth?.users ?? []).map(u => ({ id: u.id, email: u.email, isAdmin: Boolean(u.isAdmin), createdAt: u.createdAt ?? '', qa: QA_EMAIL.test(u.email ?? '') }));
const byId = new Map(users.map(u => [u.id, u]));

// --- primary owner: the same rule as server/src/tenancy/migrate.ts resolvePrimaryOwner
const wantedEmail = (option('owner-email') ?? process.env.TENANCY_DEFAULT_OWNER_EMAIL ?? '').trim();
let primaryOwner = null;
if (wantedEmail) {
  const hit = users.find(u => normalize(u.email) === normalize(wantedEmail));
  if (hit) primaryOwner = { id: hit.id, email: hit.email, via: 'env' };
  else problems.push(`TENANCY_DEFAULT_OWNER_EMAIL (${wantedEmail}) tidak cocok dengan akun mana pun: server tidak akan menetapkan pemilik`);
} else {
  const admin = users.map((u, i) => ({ u, i })).filter(({ u }) => u.isAdmin && !u.qa).sort((a, b) => a.u.createdAt.localeCompare(b.u.createdAt) || a.i - b.i)[0]?.u;
  if (admin) primaryOwner = { id: admin.id, email: admin.email, via: 'oldest-admin' };
  else if (users.length) problems.push('Tidak ada admin non-QA: tidak ada pemilik utama untuk proyek tanpa pemilik');
}

// --- stories: only the `createdBy` and `title` fields of story.json are read; title is kept ONLY for orphans.
const seenInodes = new Set();
function dirBytes(dir) {
  let total = 0;
  const walk = d => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.nlink > 1) { const key = `${st.dev}:${st.ino}`; if (seenInodes.has(key)) continue; seenInodes.add(key); }
      total += st.size;
    }
  };
  walk(dir);
  return total;
}
const storiesRoot = join(dataDir, 'stories');
const stories = { total: 0, withOwner: 0, withoutOwner: 0, orphans: [], qaOwned: [], unreadable: [] };
const buckets = new Map(); // ownerId|null -> { projects, bytes }
const bucket = id => { const k = id ?? null; if (!buckets.has(k)) buckets.set(k, { projects: 0, bytes: 0 }); return buckets.get(k); };
if (existsSync(storiesRoot)) {
  for (const id of readdirSync(storiesRoot).filter(n => STORY_ID.test(n)).sort()) {
    const file = join(storiesRoot, id, 'story.json');
    if (!existsSync(file)) continue;
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('x'); } catch { stories.unreadable.push(id); continue; }
    stories.total += 1;
    const owner = typeof record.createdBy === 'string' && record.createdBy ? record.createdBy : null;
    const bytes = wantSize ? dirBytes(join(storiesRoot, id)) : 0;
    const b = bucket(owner);
    b.projects += 1;
    b.bytes += bytes;
    if (!owner) { stories.withoutOwner += 1; continue; }
    stories.withOwner += 1;
    const user = byId.get(owner);
    if (!user) stories.orphans.push({ id, title: typeof record.title === 'string' ? record.title : '', ownerId: owner, bytes });
    else if (user.qa) stories.qaOwned.push({ id, ownerId: owner });
  }
}
const perOwner = [...buckets.entries()]
  .map(([ownerId, v]) => ({ ownerId, email: ownerId ? (byId.get(ownerId)?.email ?? null) : null, projects: v.projects, bytes: v.bytes }))
  .sort((a, b) => b.bytes - a.bytes || b.projects - a.projects);

// --- publish tokens: file names only (platform), never content
const publishTokens = { global: [], perUser: 0 };
const pubDir = join(dataDir, 'publisher');
if (existsSync(pubDir)) {
  for (const e of readdirSync(pubDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) publishTokens.global.push({ platform: e.name.slice(0, -5) });
    else if (e.isDirectory()) publishTokens.perUser += 1;
  }
  publishTokens.global.sort((a, b) => a.platform.localeCompare(b.platform));
}

// --- MCP tokens: counts per owner only (token names and hashes are never read into the output)
const mcpFile = readJson(join(dataDir, 'mcp', 'tokens.json'), 'mcp/tokens.json');
const mcpList = Array.isArray(mcpFile?.tokens) ? mcpFile.tokens : [];
const perUser = new Map();
let withoutLiveOwner = 0;
for (const t of mcpList) { if (byId.has(t.userId)) perUser.set(t.userId, (perUser.get(t.userId) ?? 0) + 1); else withoutLiveOwner += 1; }
const mcpTokens = { total: mcpList.length, withoutLiveOwner, perUser: [...perUser.entries()].map(([userId, count]) => ({ userId, email: byId.get(userId).email, count })) };

// --- Flow jobs: attribution counts only (T4 backfills createdBy)
const flow = readJson(join(dataDir, 'flow', 'flow.json'), 'flow/flow.json');
const jobs = Array.isArray(flow?.jobs) ? flow.jobs : [];
const kindOf = j => (typeof j.technique === 'string' && j.technique.startsWith('story:') ? 'story' : typeof j.technique === 'string' && j.technique.startsWith('cover:') ? 'cover' : 'studio');
const flowJobs = { total: jobs.length, withoutCreatedBy: jobs.filter(j => !j.createdBy).length, byKind: { story: 0, cover: 0, studio: 0 } };
for (const j of jobs.filter(j => !j.createdBy)) flowJobs.byKind[kindOf(j)] += 1;

// --- free-generate files (no owner index yet), migrations already run
let genFiles = 0;
for (const kind of ['tts', 'images', 'clips']) { const d = join(dataDir, 'free-generate', kind); if (existsSync(d)) { try { genFiles += readdirSync(d).length; } catch { /* ignore */ } } }
const migDir = join(dataDir, 'tenancy', 'migrations');
const migrations = existsSync(migDir) ? readdirSync(migDir).filter(n => n.endsWith('.json')).sort() : [];

const result = {
  dataDir, generatedAt: new Date().toISOString(), members: users, primaryOwner, stories, perOwner,
  wouldAssign: primaryOwner ? stories.withoutOwner : 0,
  publishTokens, mcpTokens, flowJobs, freeGenerate: { files: genFiles }, migrations, problems
};

if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const out = [];
out.push(`Inventaris tenancy — ${dataDir} (hanya-baca)`);
out.push('');
out.push(`Anggota (${users.length}):`);
for (const u of users) out.push(`  ${u.id}  ${u.email}  ${u.isAdmin ? 'admin' : 'member'}${u.qa ? '  [QA]' : ''}`);
out.push(`Pemilik utama untuk proyek tanpa pemilik: ${primaryOwner ? `${primaryOwner.email} (${primaryOwner.via === 'env' ? 'TENANCY_DEFAULT_OWNER_EMAIL' : 'admin tertua non-QA'})` : 'TIDAK ADA'}`);
out.push('');
out.push(`Proyek: ${stories.total} (punya pemilik ${stories.withOwner}, TANPA pemilik ${stories.withoutOwner}, yatim ${stories.orphans.length}, milik akun QA ${stories.qaOwned.length}, story.json tidak terbaca ${stories.unreadable.length})`);
out.push(`Akan ditetapkan ke pemilik utama saat boot: ${result.wouldAssign}`);
for (const o of stories.orphans) out.push(`  YATIM  ${o.id}  "${o.title}"  pemilik lama ${o.ownerId}  ${mb(o.bytes)}`);
for (const q of stories.qaOwned) out.push(`  QA     ${q.id}  pemilik ${q.ownerId}`);
for (const id of stories.unreadable) out.push(`  RUSAK  ${id}`);
out.push('');
out.push(`Ukuran per pemilik${wantSize ? '' : ' (dilewati: --no-size)'}:`);
for (const o of perOwner) out.push(`  ${o.ownerId ? (o.email ?? `${o.ownerId} (akun sudah tidak ada)`) : '(tanpa pemilik)'}  ${o.projects} proyek  ${mb(o.bytes)}`);
out.push('');
out.push(`Token publish GLOBAL (satu per platform, belum per pengguna): ${publishTokens.global.length ? publishTokens.global.map(t => t.platform).join(', ') : 'tidak ada'}`);
out.push(`Token MCP: ${mcpTokens.total} (pemilik sudah tidak ada: ${mcpTokens.withoutLiveOwner})`);
for (const t of mcpTokens.perUser) out.push(`  ${t.email}  ${t.count}`);
out.push(`Job Flow: ${flowJobs.total}; tanpa createdBy ${flowJobs.withoutCreatedBy} (story ${flowJobs.byKind.story}, cover ${flowJobs.byKind.cover}, studio ${flowJobs.byKind.studio})`);
out.push(`Berkas free-generate tanpa pemilik: ${genFiles}`);
out.push(`Migrasi tenancy yang sudah berjalan: ${migrations.length ? migrations.join(', ') : 'belum ada'}`);
if (problems.length) { out.push(''); out.push('MASALAH:'); for (const p of problems) out.push(`  - ${p}`); }
console.log(out.join('\n'));

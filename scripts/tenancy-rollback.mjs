#!/usr/bin/env node
// Undo `ensureOwners` (the tenancy boot migration) from its manifest.
//   node scripts/tenancy-rollback.mjs /data/tenancy/migrations/<stamp>.json [--dry-run] [--data-dir=/data]
// Needs nothing but Node (no build, no dependencies): in the container, copy it in or pipe it:
//   docker exec -i <container> node - /data/tenancy/migrations/<stamp>.json --dry-run < scripts/tenancy-rollback.mjs
// A story.json still exactly as the migration wrote it goes back to the backed-up bytes; one that changed since (the project moved on)
// only loses the three owner fields (createdBy, ownerAssignedBy, ownerAssignedAt) the migration added. Backups are never deleted.
// Prints ids and counts only, never project titles or content. NOTE: stop the app first (or accept that a running server may rewrite a
// story at the same moment); the next boot assigns the primary owner again unless TENANCY_MIGRATE=0.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MIGRATION_ID = 'migrasi-tenancy-1';
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const manifestPath = args[0];
if (!manifestPath) { console.error('Pemakaian: node scripts/tenancy-rollback.mjs <manifest.json> [--dry-run]'); process.exit(2); }

const sha256 = data => createHash('sha256').update(data).digest('hex');
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, file); } catch (error) { rmSync(tmp, { force: true }); throw error; }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.id !== MIGRATION_ID) { console.error(`Manifest ${manifest.id} bukan ${MIGRATION_ID}`); process.exit(2); }
const override = process.argv.find(a => a.startsWith('--data-dir='))?.slice('--data-dir='.length);
const dataDir = override || manifest.dataDir || dirname(dirname(dirname(manifestPath)));
const tenancy = join(dataDir, 'tenancy');
const restored = [], reverted = [], skipped = [];
for (const entry of manifest.entries) {
  const file = join(dataDir, entry.file);
  let current;
  try { current = readFileSync(file); } catch { skipped.push(entry.id); continue; }
  const now = sha256(current);
  if (now === entry.sha256Before) { skipped.push(entry.id); continue; }
  if (now === entry.sha256After) {
    if (!dryRun) writeAtomic(file, readFileSync(join(tenancy, entry.backup)));
    restored.push(entry.id);
    continue;
  }
  const record = JSON.parse(current.toString('utf8'));
  if (record.createdBy !== entry.after || record.ownerAssignedBy !== MIGRATION_ID) { skipped.push(entry.id); continue; }
  delete record.createdBy; delete record.ownerAssignedBy; delete record.ownerAssignedAt;
  if (!dryRun) writeAtomic(file, JSON.stringify(record, null, 1));
  reverted.push(entry.id);
}
console.log(`${dryRun ? '[dry-run] ' : ''}rollback ${MIGRATION_ID}: dikembalikan ${restored.length}, hanya field pemilik ${reverted.length}, dilewati ${skipped.length}`);
for (const id of restored) console.log(`  dikembalikan  ${id}`);
for (const id of reverted) console.log(`  field-pemilik ${id}`);
for (const id of skipped) console.log(`  dilewati      ${id}`);

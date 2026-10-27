#!/usr/bin/env node
/**
 * Axcel E2E: the real server worker → the real Mac bridge → axcel.cloud → a downloaded clip.
 *
 *   AXCEL_BRIDGE_TOKEN=… npx tsx scripts/axcel-e2e.ts [video|image]
 *
 * Uses a throwaway data dir, so it never touches the live `flow.json`. Prints one JSON line with
 * the job status, the file and its size; exits non-zero when the render did not land.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowStore } from '../server/src/flow/store.js';
import { AxcelClient, AxcelConfigStore, AxcelWorker } from '../server/src/providers/axcel.js';

const kind = process.argv[2] === 'image' ? 'image' : 'video';
const dataDir = await mkdtemp(join(tmpdir(), 'axcel-e2e-'));
const config = new AxcelConfigStore(dataDir);
const settings = await config.settings();
if (!settings.token) {
  console.error('AXCEL_BRIDGE_TOKEN belum diset (lihat ~/.config/opencreator/axcel-bridge.env)');
  process.exit(2);
}
const client = new AxcelClient(fetch, { url: settings.url, token: settings.token });
const health = await client.health();
console.error(`bridge ok: ${health.akun} · plan ${health.plan}`);

const store = new FlowStore(dataDir);
const job = await store.createJob({
  provider: 'axcel',
  model: kind === 'image' ? 'Nano Banana Pro' : 'Seedance 2.0',
  kind,
  prompt: kind === 'image'
    ? 'sepeda merah bersandar di dinding kapur putih, cahaya pagi lembut, foto 35mm'
    : 'nelayan tua menarik jaring di pantai saat fajar, kamera dolly perlahan',
  aspect: '9:16',
  durationSec: 5
});
console.error(`queued ${job.id} (${job.model})`);

const worker = new AxcelWorker({ store, client: async () => client });
await worker.tick();
await worker.idle();

const done = await store.getJob(job.id);
console.log(JSON.stringify({
  id: job.id,
  status: done?.status,
  model: done?.model,
  provider: done?.provider,
  file: done?.resultPath,
  bytes: done?.bytes,
  error: done?.error
}, null, 1));
process.exit(done?.status === 'done' && (done.bytes ?? 0) > 1024 ? 0 : 1);

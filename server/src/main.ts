import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createMotionQc } from './media/motion-qc.js';

const dataDir = process.env.OPENCREATOR_DATA_DIR || process.env.DATA_DIR || '/data';
const webDist = process.env.WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url));
let version = process.env.APP_VERSION ?? 'dev';
try { version = readFileSync(new URL('./BUILD', import.meta.url), 'utf8').trim() || version; } catch { /* dev */ }

// Motion QC needs python3 + numpy (the image has them); without them every check just gives no verdict.
const app = await buildApp({ dataDir, webDist, version, logger: process.env.NODE_ENV !== 'test', stories: { motion: createMotionQc() } });
const port = Number(process.env.PORT || 3000);
await app.listen({ host: '0.0.0.0', port });
console.log(`[nirmalab-creator] ${version} listening on :${port}, data ${dataDir}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}

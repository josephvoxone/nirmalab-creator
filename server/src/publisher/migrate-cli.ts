import { pathToFileURL } from 'node:url';
import { rollbackLegacyPublisherTokens } from './migrate.js';

/**
 * Operator tool (no network, no secrets printed):
 *   node server/dist/publisher/migrate-cli.js rollback <dataDir> <manifest path | run id>
 * Puts the pre-tenancy global `<platform>.json` token files back (from the owner's current token or the backup).
 */
export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [command, dataDir, manifest] = argv;
  if (command !== 'rollback' || !dataDir || !manifest) {
    out('usage: migrate-cli rollback <dataDir> <manifest path | run id>');
    return 2;
  }
  const result = await rollbackLegacyPublisherTokens({ dataDir, manifest });
  out(`${result.status}: restored [${result.restored.join(', ')}] skipped [${result.skipped.join(', ')}]`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}

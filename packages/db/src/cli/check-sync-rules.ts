/**
 * Sync-rules lint (S3 DoD). Uses @powersync/service-sync-rules — the exact
 * parser the PowerSync service runs — since no standalone validating CLI is
 * published (`@powersync/cli` does not exist; the `powersync` package manages
 * cloud instances).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlSyncRules } from '@powersync/service-sync-rules';

const rulesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'sync-rules.yaml',
);

const rules = SqlSyncRules.fromYaml(readFileSync(rulesPath, 'utf8'), {
  throwOnError: false,
  defaultSchema: 'public',
});

if (rules.errors.length > 0) {
  console.error(`sync-rules.yaml: ${rules.errors.length} problem(s)`);
  for (const error of rules.errors) console.error(` - ${error.message}`);
  process.exit(1);
}
console.log('sync-rules.yaml: valid');

/**
 * Sync-config lint (S3 / M4 DoD). Validates packages/db/sync-streams.yaml with
 * @powersync/service-sync-rules — the exact parser the PowerSync service runs —
 * since no standalone validating CLI is published (`@powersync/cli` does not
 * exist; the `powersync` package manages cloud instances). Fails on errors;
 * warnings are printed but non-fatal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlSyncRules } from '@powersync/service-sync-rules';

const rulesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'sync-streams.yaml',
);

const rules = SqlSyncRules.fromYaml(readFileSync(rulesPath, 'utf8'), {
  throwOnError: false,
  defaultSchema: 'public',
});

const errors = rules.errors.filter((e) => e.type !== 'warning');
const warnings = rules.errors.filter((e) => e.type === 'warning');
for (const w of warnings) console.warn(`sync-streams.yaml: warning - ${w.message}`);

if (errors.length > 0) {
  console.error(`sync-streams.yaml: ${errors.length} problem(s)`);
  for (const error of errors) console.error(` - ${error.message}`);
  process.exit(1);
}
console.log('sync-streams.yaml: valid');

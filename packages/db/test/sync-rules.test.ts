/**
 * S3 DoD: sync-rules lint. Validates packages/db/sync-rules.yaml with
 * @powersync/service-sync-rules — the same parser the PowerSync service runs
 * — and checks the §7.3 coverage rule: every table except command_log.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlSyncRules } from '@powersync/service-sync-rules';
import { describe, expect, it } from 'vitest';

import { tables } from '../src/schema';

const rulesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'sync-rules.yaml',
);
const yaml = readFileSync(rulesPath, 'utf8');

describe('sync-rules.yaml (§7.3)', () => {
  it('parses without errors (PowerSync rules engine)', () => {
    const rules = SqlSyncRules.fromYaml(yaml, {
      throwOnError: false,
      defaultSchema: 'public',
    });
    expect(rules.errors.map((e) => e.message)).toEqual([]);
  });

  it('syncs every table except command_log', () => {
    const tableNames = Object.keys(tables).filter((t) => t !== 'command_log');
    for (const table of tableNames) {
      expect(yaml, `missing sync rule for ${table}`).toMatch(
        new RegExp(`FROM ${table}\\b`),
      );
    }
    expect(yaml).not.toMatch(/FROM command_log\b/);
  });

  it('scopes every data query to the user bucket', () => {
    const dataQueries = yaml
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- SELECT'));
    expect(dataQueries.length).toBeGreaterThanOrEqual(18);
    for (const query of dataQueries) {
      expect(query).toContain('WHERE user_id = bucket.user_id');
    }
  });
});

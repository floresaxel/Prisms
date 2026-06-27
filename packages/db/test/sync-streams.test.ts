/**
 * M0 spike — Sync Streams tiering DRAFT validation (1.3 §7.3).
 *
 * De-risks the M4 migration: the Tier 0/1 draft must parse with the exact
 * PowerSync rules engine, be JWT-scoped, and expose NO client-widenable
 * parameter — so cross-user isolation holds. (The production single-bucket
 * sync-rules.yaml is unchanged and validated separately.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlSyncRules } from '@powersync/service-sync-rules';
import { describe, expect, it } from 'vitest';

const draftPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-streams.tier0.yaml');
const yaml = readFileSync(draftPath, 'utf8');

describe('sync-streams.tier0.yaml (Tier 0/1 draft, §7.3)', () => {
  it('parses without errors (PowerSync rules engine)', () => {
    const rules = SqlSyncRules.fromYaml(yaml, { throwOnError: false, defaultSchema: 'public' });
    expect(rules.errors.map((e) => e.message)).toEqual([]);
  });

  it('places nodes (the M0 slice) in Tier 0 bootstrap', () => {
    const tier0 = yaml.slice(yaml.indexOf('tier0_bootstrap'), yaml.indexOf('tier1_active'));
    expect(tier0).toMatch(/FROM nodes\b/);
  });

  it('scopes every data query to the JWT user bucket', () => {
    const dataQueries = yaml.split('\n').filter((line) => line.trimStart().startsWith('- SELECT'));
    expect(dataQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of dataQueries) {
      expect(query, query).toContain('WHERE user_id = bucket.user_id');
    }
  });

  it('derives the bucket parameter only from the verified JWT (no client-widenable params)', () => {
    const paramLines = yaml.split('\n').filter((line) => line.includes('parameters:'));
    expect(paramLines.length).toBeGreaterThanOrEqual(2);
    for (const line of paramLines) {
      expect(line).toContain('request.user_id()');
    }
    // a client must not be able to pass a parameter that widens scope.
    expect(yaml).not.toMatch(/request\.parameters\(/);
    expect(yaml).not.toMatch(/token_parameters/);
  });
});

/**
 * M4 — Sync Streams config (§7.3). Validates packages/db/sync-streams.yaml with
 * the exact PowerSync rules engine, and pins the convergence guarantees:
 * compiled edition-3 streams; every synced table placed in a tier; every query
 * JWT-scoped via auth.user_id(); no client-widenable parameter (so cross-user
 * isolation holds); command_log only via a filtered command-result stream;
 * Tier 2 (history) lazily subscribed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlSyncRules } from '@powersync/service-sync-rules';
import { describe, expect, it } from 'vitest';

import { tables } from '../src/schema';

const yaml = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-streams.yaml'),
  'utf8',
);
const parsed = SqlSyncRules.fromYaml(yaml, { throwOnError: false, defaultSchema: 'public' });
const queryLines = yaml.split('\n').map((l) => l.trim()).filter((l) => l.includes('SELECT '));

describe('sync-streams.yaml (§7.3)', () => {
  it('parses with no errors or warnings (compiled streams engine)', () => {
    expect(parsed.errors.map((e) => `${e.type ?? 'error'}: ${e.message}`)).toEqual([]);
  });

  it('is a compiled edition-3 Sync Streams config (not legacy bucket_definitions)', () => {
    expect(yaml).toMatch(/edition:\s*3/);
    expect(yaml).toMatch(/^streams:/m);
    expect(yaml).not.toMatch(/^bucket_definitions:/m);
  });

  it('places every synced table in a stream (command_log via the command-result stream)', () => {
    for (const table of Object.keys(tables)) {
      expect(yaml, `missing stream query for ${table}`).toMatch(new RegExp(`FROM ${table}\\b`));
    }
    // the two new 1.3 tables are now synced
    expect(yaml).toMatch(/FROM schedule_suggestion_batches\b/);
    expect(yaml).toMatch(/FROM sync_review_items\b/);
    // command_log is synced ONLY through the filtered command_results stream
    expect(yaml).toMatch(/command_results:[\s\S]*?FROM command_log\b/);
    expect(yaml.match(/FROM command_log\b/g)?.length).toBe(1);
  });

  it('scopes every query to the verified JWT user (auth.user_id())', () => {
    expect(queryLines.length).toBeGreaterThanOrEqual(24);
    for (const line of queryLines) {
      expect(line, line).toContain('auth.user_id()');
    }
  });

  it('exposes no client-widenable parameter (cross-user isolation)', () => {
    expect(yaml).not.toMatch(/subscription\.parameter/);
    expect(yaml).not.toMatch(/token_parameters/);
    expect(yaml).not.toMatch(/request\.parameters/);
  });

  it('subscribes Tier 0/1 automatically and Tier 2 (history) lazily', () => {
    const history = yaml.slice(yaml.indexOf('history:'));
    expect(history).toMatch(/auto_subscribe:\s*false/);
    // the bootstrap/active tiers auto-subscribe
    const bootstrap = yaml.slice(yaml.indexOf('bootstrap:'), yaml.indexOf('active:'));
    expect(bootstrap).toMatch(/auto_subscribe:\s*true/);
  });
});

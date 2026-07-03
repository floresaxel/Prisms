/**
 * M4 — Sync Streams config (§7.3). Validates packages/db/sync-streams.yaml with
 * the exact PowerSync rules engine, and pins the convergence guarantees:
 * compiled edition-3 streams; every synced table placed in a tier; every query
 * JWT-scoped via auth.user_id(); no client-widenable parameter (so cross-user
 * isolation holds); command_log is NOT synced (R10/S6-F2 dropped the broad
 * command_results stream); soft-deleted tombstones live in Tier 2 (R10/S6-F1);
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

  it('places every SYNCED table in a stream; command_log is intentionally NOT synced (S6-F2)', () => {
    // command_log is the one domain table clients never replicate — R10 dropped
    // the command_results stream that shipped the full 90-day log to every device.
    const NOT_SYNCED = new Set(['command_log']);
    for (const table of Object.keys(tables)) {
      if (NOT_SYNCED.has(table)) continue;
      expect(yaml, `missing stream query for ${table}`).toMatch(new RegExp(`FROM ${table}\\b`));
    }
    // the two new 1.3 tables are now synced
    expect(yaml).toMatch(/FROM schedule_suggestion_batches\b/);
    expect(yaml).toMatch(/FROM sync_review_items\b/);
    // S6-F2: command_log has NO stream and the command_results stream is gone
    expect(yaml).not.toMatch(/FROM command_log\b/);
    expect(yaml).not.toMatch(/command_results:/);
  });

  it('keeps soft-deleted tombstones out of the auto-subscribed tiers → Tier 2 (S6-F1)', () => {
    const TOMBSTONE_TIERED = ['nodes', 'edges', 'schedule_blocks', 'time_entries', 'habit_completions', 'diagram_layouts'];
    // the live tiers filter deleted_at IS NULL on the high-volume tables…
    for (const t of TOMBSTONE_TIERED) {
      expect(yaml, `${t} live query must exclude tombstones`).toMatch(
        new RegExp(`FROM ${t} WHERE user_id = auth\\.user_id\\(\\) AND deleted_at IS NULL\\b`),
      );
    }
    // …and their tombstones are in the lazily-subscribed history tier
    const history = yaml.slice(yaml.indexOf('history:'));
    for (const t of TOMBSTONE_TIERED) {
      expect(history, `${t} tombstones must be in Tier 2`).toMatch(
        new RegExp(`FROM ${t} WHERE user_id = auth\\.user_id\\(\\) AND deleted_at IS NOT NULL\\b`),
      );
    }
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

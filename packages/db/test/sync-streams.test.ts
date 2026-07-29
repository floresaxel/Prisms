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

  it('subscription parameters only NARROW, never widen (cross-user isolation holds; J1/D3)', () => {
    // Journal lazily scopes by month via a client SUBSCRIPTION parameter. The
    // invariant is not "no parameters" but "a parameter only narrows within the
    // user's own rows": every query that reads subscription.parameters() must
    // STILL filter auth.user_id(). Auth-level / unauthenticated request params
    // remain forbidden — those could bypass the per-user scoping entirely.
    expect(yaml).not.toMatch(/token_parameters/);
    expect(yaml).not.toMatch(/request\.parameters/);
    const paramLines = queryLines.filter((l) => l.includes('subscription.parameter'));
    expect(paramLines.length).toBeGreaterThanOrEqual(1); // journal_month
    for (const line of paramLines) {
      expect(line, line).toContain('auth.user_id()');
    }
  });

  it('bootstrap ships every user_settings column clients read (Annex L flag)', () => {
    // The settings query is the one EXPLICIT column list in the file: a column
    // missing here never reaches a device, and its toggle is silently dead —
    // the client keeps rendering its own default forever. Pin the list.
    const settingsQuery = queryLines.find((l) => l.includes('FROM user_settings'));
    expect(settingsQuery).toBeDefined();
    for (const col of ['day_reset_hour', 'timezone', 'weather_location', 'journal_day_log', 'updated_at']) {
      expect(settingsQuery, `bootstrap must select ${col}`).toContain(col);
    }
  });

  it('adds NO table for the journal day log — it is derived at read time (Annex L)', () => {
    expect(yaml).not.toMatch(/FROM journal_day_logs?\b/);
  });

  it('subscribes Tier 0/1 automatically and Tier 2 (history) lazily', () => {
    const history = yaml.slice(yaml.indexOf('history:'));
    expect(history).toMatch(/auto_subscribe:\s*false/);
    // the bootstrap/active tiers auto-subscribe
    const bootstrap = yaml.slice(yaml.indexOf('bootstrap:'), yaml.indexOf('active:'));
    expect(bootstrap).toMatch(/auto_subscribe:\s*true/);
  });
});

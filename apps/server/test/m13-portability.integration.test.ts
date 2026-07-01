/**
 * M13 DoD — portable export/import (§13.1, R20) vs real Postgres:
 *   - export includes facts/settings/command-history, excludes secrets;
 *   - dry-run reports conflicts and writes NO data rows;
 *   - restore-after-loss brings the rows back as data (FK order intact), stamped
 *     source_kind='import', WITHOUT replaying commands;
 *   - a newer local row is kept over an older imported one (LWW → deterministic);
 *   - a re-import is idempotent (no duplicate rows);
 *   - a cross-account import cannot steal another user's globally-keyed rows;
 *   - an unsupported version / malformed manifest yields an import_warning.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { exportManifestSchema } from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { runBackupSnapshot } from '../src/jobs/backup-snapshot';
import { runImportRestore } from '../src/jobs/import-restore';
import { runImportValidate } from '../src/jobs/import-validate';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const NOW_MS = Date.parse('2026-06-30T16:00:00.000Z');
const clock = { now: () => NOW_MS };

let seq = 0;
const cmd = (name: string, payload: unknown, id = randomUUID()) => ({
  id,
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-seed`,
  payload,
});

/** Child-before-parent order so a raw wipe never trips a foreign key. */
const WIPE_ORDER = [
  'tag_answers', 'decision_scores', 'tag_placements', 'habit_completions',
  'edges', 'schedule_blocks', 'time_entries', 'sprint_memberships', 'diagram_layouts', 'diagram_groups', 'decision_criteria',
  'habits',
  'nodes', 'tags', 'decision_boards', 'sprints', 'automation_rules', 'blocker_rules', 'external_facts', 'computed_aggregates', 'schedule_suggestion_batches', 'sync_review_items',
  'command_log', 'user_settings',
];

describe.skipIf(!adminUrl)('M13 portability — export / import round-trip', () => {
  const dbName = `prisms_m13_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;

  const apply = async (userId: string, commands: ReturnType<typeof cmd>[]) => {
    const res = await dispatcher.handleUpload(userId, { device_id: 'seed', commands });
    if (res.kind !== 'ok') throw new Error(`dispatch failed: ${res.kind}`);
    return res.results;
  };

  /** A justified vision→roadmap→project→task chain + a habit + a decision board + settings. */
  async function seedUser() {
    const user = randomUUID();
    const ids = { user, v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID(), h: randomUUID(), b: randomUUID() };
    await apply(user, [
      cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
      cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
      cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
      cmd('node.create', { id: ids.t, node_type: 'task', title: 'Task One', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
      cmd('habit.create', { id: ids.h, vision_id: ids.v, title: 'Morning Run', rrule: 'FREQ=DAILY', streak_mode: 'daily' }),
      cmd('board.create', { id: ids.b, title: 'Priorities' }),
      cmd('settings.update', { day_reset_hour: 5, timezone: 'America/Chicago' }),
    ]);
    return ids;
  }

  async function wipe(userId: string) {
    for (const t of WIPE_ORDER) await sql.unsafe(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
  }
  const nodeCount = async (userId: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM nodes WHERE user_id = ${userId} AND deleted_at IS NULL`)[0]!['n']);

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 6, onnotice: () => undefined });
    db = drizzle(sql);
    dispatcher = createDispatcher(db, createRateLimiter({ limit: 100_000, windowMs: 60_000 }));
  });

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('export is a valid manifest with facts + settings + command history, and no secrets', async () => {
    const ids = await seedUser();
    const manifest = await runBackupSnapshot(db, ids.user, clock);
    expect(exportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.tables['nodes']).toHaveLength(4);
    expect(manifest.tables['habits']).toHaveLength(1);
    expect(manifest.tables['decision_boards']).toHaveLength(1);
    expect(manifest.tables['user_settings']).toHaveLength(1);
    expect((manifest.command_history ?? []).length).toBeGreaterThan(0);
    // secrets are never exported (auth/push tables are not in the registry)
    for (const secret of ['user', 'session', 'account', 'verification', 'push_subscriptions']) {
      expect(manifest.tables[secret]).toBeUndefined();
    }
  });

  it('dry-run reports row counts + conflicts and writes NO data rows', async () => {
    const ids = await seedUser();
    const manifest = await runBackupSnapshot(db, ids.user, clock);
    await wipe(ids.user);
    expect(await nodeCount(ids.user)).toBe(0);

    const report = await runImportValidate(db, ids.user, manifest, clock);
    expect(report.format_ok).toBe(true);
    expect(report.row_counts['nodes']).toBe(4);
    expect(report.conflicts).toHaveLength(0); // wiped → no id collisions
    // the dry-run wrote no data rows (only informational review items, and none here)
    expect(await nodeCount(ids.user)).toBe(0);
  });

  it('restore-after-loss brings rows back as data (FK order), stamped import, no replay', async () => {
    const ids = await seedUser();
    const manifest = await runBackupSnapshot(db, ids.user, clock);
    const cmdCountBefore = Number((await sql`SELECT count(*)::int AS n FROM command_log WHERE user_id = ${ids.user}`)[0]!['n']);
    await wipe(ids.user);
    expect(await nodeCount(ids.user)).toBe(0);

    const result = await runImportRestore(db, ids.user, manifest, clock);
    expect(result.ok).toBe(true);
    expect(result.restored['nodes']).toBe(4);

    // rows are back, FK chain intact (task's parent restored) and import-stamped
    expect(await nodeCount(ids.user)).toBe(4);
    const task = (await sql`SELECT parent_id, source_kind FROM nodes WHERE id = ${ids.t}`)[0]!;
    expect(task['parent_id']).toBe(ids.p);
    expect(task['source_kind']).toBe('import');
    // habit + board came back too
    expect(Number((await sql`SELECT count(*)::int AS n FROM habits WHERE user_id = ${ids.user} AND deleted_at IS NULL`)[0]!['n'])).toBe(1);
    // command history restored as data (non-replayable): same count, NOT re-dispatched
    const cmdCountAfter = Number((await sql`SELECT count(*)::int AS n FROM command_log WHERE user_id = ${ids.user}`)[0]!['n']);
    expect(cmdCountAfter).toBe(cmdCountBefore);

    // re-import is idempotent (equal hlc → kept; no duplicates)
    const again = await runImportRestore(db, ids.user, manifest, clock);
    expect(again.conflicts.length).toBeGreaterThan(0);
    expect(await nodeCount(ids.user)).toBe(4);
  });

  it('a newer local row is kept over an older imported one (LWW, deterministic)', async () => {
    const ids = await seedUser();
    const manifest = await runBackupSnapshot(db, ids.user, clock);
    // a newer local edit (higher hlc than the export)
    await apply(ids.user, [cmd('node.rename', { id: ids.t, title: 'Renamed Locally' })]);

    const result = await runImportRestore(db, ids.user, manifest, clock);
    expect(result.conflicts.some((c) => c.id === ids.t && /newer local/.test(c.reason))).toBe(true);
    const title = (await sql`SELECT title FROM nodes WHERE id = ${ids.t}`)[0]!['title'];
    expect(title).toBe('Renamed Locally'); // import did NOT clobber the newer row
  });

  it('a cross-account import cannot steal another account’s globally-keyed rows', async () => {
    const a = await seedUser();
    const manifest = await runBackupSnapshot(db, a.user, clock);
    const b = randomUUID();

    const result = await runImportRestore(db, b, manifest, clock);
    // every node id collides with account A → all skipped as "another account"
    expect(result.restored['nodes'] ?? 0).toBe(0);
    expect(result.conflicts.some((c) => /another account/.test(c.reason))).toBe(true);
    // A still owns its rows; B stole nothing
    expect((await sql`SELECT user_id FROM nodes WHERE id = ${a.t}`)[0]!['user_id']).toBe(a.user);
    expect(await nodeCount(b)).toBe(0);
  });

  it('an unsupported version and a malformed manifest each yield an import_warning', async () => {
    const u = randomUUID();
    const bad = await runImportRestore(db, u, { format: 'prisms-export', format_version: 99, schema_version: 1, exported_at: '2026-06-30T00:00:00.000Z', device_id: 'x', hlc_high_water: '000000000000-0000-x', tables: {} }, clock);
    expect(bad.ok).toBe(false);
    const garbage = await runImportRestore(db, u, { nope: true }, clock);
    expect(garbage.ok).toBe(false);
    const items = await sql`SELECT count(*)::int AS n FROM sync_review_items WHERE user_id = ${u} AND item_type = 'import_warning'`;
    expect(Number(items[0]!['n'])).toBe(2);
  });
});

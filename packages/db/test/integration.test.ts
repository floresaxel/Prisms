/**
 * S3 DoD integration: against a real postgres (the compose stack), prove that
 * (1) migrations apply cleanly to a FRESH database, (2) the seed runs, and
 * (3) the DB-level invariant backstops (§6.7 I1 trigger, I5 partial unique
 * index, I6 checks) actually reject bad rows.
 *
 * Requires PRISMS_DB_TEST_URL (a superuser-ish connection to any database on
 * the server, used to CREATE/DROP a throwaway database). Skipped when unset
 * so the repo gate stays green without the stack; CI sets it against the
 * compose postgres.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/migrate';
import { DEMO_USER_ID, seedDemoUser } from '../src/seed';

const adminUrl = process.env.PRISMS_DB_TEST_URL;

describe.skipIf(!adminUrl)('migrations + seed against fresh postgres', () => {
  const dbName = `prisms_s3_test_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies migrations cleanly to a fresh database', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    // the §6.0 tables + 4 better-auth + 2 server-internal (command_field_versions
    // s12, push_subscriptions s14) + 3 tag tables + the 2 M3 1.3 tables
    // (schedule_suggestion_batches §7.5, sync_review_items §7.13) + journal_entries
    // (J1 §6.0); drizzle bookkeeping lives in its own schema
    const expected = [
      'account', 'automation_rules', 'blocker_rules', 'command_field_versions',
      'command_log', 'computed_aggregates', 'decision_boards',
      'decision_criteria', 'decision_scores', 'diagram_groups',
      'diagram_layouts', 'edges', 'external_facts', 'habit_completions',
      'habits', 'journal_entries', 'nodes', 'push_subscriptions', 'schedule_blocks',
      'schedule_suggestion_batches', 'session', 'sprint_memberships', 'sprints',
      'sync_review_items', 'tag_answers', 'tag_placements', 'tags',
      'time_entries', 'user', 'user_settings', 'verification',
    ];
    expect(rows.map((t) => t.table_name)).toEqual(expected);
  });

  it('migrations are idempotent (re-run is a no-op)', async () => {
    await runMigrations(url);
  });

  it('seed runs and is deterministic across re-runs', async () => {
    const first = await seedDemoUser(url);
    expect(first).toEqual({
      nodes: 22,
      habits: 3,
      habit_completions: 8,
      edges: 6,
      time_entries: 8,
      journal_entries: 2,
    });
    const idsBefore = (await sql`SELECT id FROM nodes ORDER BY id`).map((r) => r['id']);
    await seedDemoUser(url);
    const idsAfter = (await sql`SELECT id FROM nodes ORDER BY id`).map((r) => r['id']);
    expect(idsAfter).toEqual(idsBefore);

    const visions = await sql`
      SELECT title FROM nodes
      WHERE user_id = ${DEMO_USER_ID} AND node_type = 'vision' AND deleted_at IS NULL
      ORDER BY sort_order`;
    expect(visions.map((v) => v['title'])).toEqual([
      'Wellness',
      'Work',
      'Knowledge',
      'Expression',
    ]);
  });

  it('I1 trigger rejects a task under a vision', async () => {
    const [vision] = await sql`
      SELECT id FROM nodes WHERE user_id = ${DEMO_USER_ID} AND node_type = 'vision' LIMIT 1`;
    await expect(
      sql`INSERT INTO nodes (id, user_id, parent_id, node_type, title, sort_order, updated_at)
          VALUES (gen_random_uuid(), ${DEMO_USER_ID}, ${vision!['id']}, 'task', 'bad', 'a0', now())`,
    ).rejects.toThrow(/E_HIERARCHY: a task cannot be a child of a vision/);
  });

  it('I1 trigger rejects a parentless roadmap', async () => {
    await expect(
      sql`INSERT INTO nodes (id, user_id, node_type, title, sort_order, updated_at)
          VALUES (gen_random_uuid(), ${DEMO_USER_ID}, 'roadmap', 'bad', 'a0', now())`,
    ).rejects.toThrow(/E_HIERARCHY: a roadmap requires a parent/);
  });

  it('I5 partial unique index allows one open entry, rejects a second', async () => {
    const [task] = await sql`
      SELECT id FROM nodes WHERE user_id = ${DEMO_USER_ID} AND node_type = 'task' LIMIT 1`;
    const open = () =>
      sql`INSERT INTO time_entries (id, user_id, task_id, started_at, device_id, updated_at)
          VALUES (gen_random_uuid(), ${DEMO_USER_ID}, ${task!['id']}, now(), 'test-device', now())`;
    await open();
    await expect(open()).rejects.toThrow(/entries_open/);
    await sql`DELETE FROM time_entries WHERE ended_at IS NULL AND user_id = ${DEMO_USER_ID}`;
  });

  it('I6 check rejects a block that ends before it starts', async () => {
    const [task] = await sql`
      SELECT id FROM nodes WHERE user_id = ${DEMO_USER_ID} AND node_type = 'task' LIMIT 1`;
    await expect(
      sql`INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, updated_at)
          VALUES (gen_random_uuid(), ${DEMO_USER_ID}, ${task!['id']},
                  '2026-06-12T10:00:00Z', '2026-06-12T09:00:00Z', now())`,
    ).rejects.toThrow(/blocks_interval_check/);
  });

  it('focus_factor check rejects out-of-range values', async () => {
    const [task] = await sql`
      SELECT id FROM nodes WHERE user_id = ${DEMO_USER_ID} AND node_type = 'task' LIMIT 1`;
    await expect(
      sql`INSERT INTO time_entries (id, user_id, task_id, started_at, ended_at, focus_factor, device_id, updated_at)
          VALUES (gen_random_uuid(), ${DEMO_USER_ID}, ${task!['id']},
                  '2026-06-12T08:00:00Z', '2026-06-12T09:00:00Z', 0.3, 'test-device', now())`,
    ).rejects.toThrow(/entries_focus_factor_check/);
  });
});

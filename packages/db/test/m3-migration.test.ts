/**
 * M3 — the 1.3 schema migration (0008) is live-DB-safe (§§7.1, 7.7, 7.8, 7.11).
 *
 * (1) Applying 0008 to a POPULATED (pre-0008) database preserves row counts and
 *     backfills legacy rows with the floor schema_version, the sentinel hlc, and
 *     source_kind='legacy' ("origin unknown").
 * (2) The §7.7 partial unique indexes allow recreate-after-soft-delete on every
 *     soft-deletable table (the plain UNIQUE constraints would have blocked it).
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/migrate';

const adminUrl = process.env.PRISMS_DB_TEST_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const PRE_0008 = [
  '0000_init',
  '0001_hierarchy_trigger',
  '0002_better_auth',
  '0003_field_versions',
  '0004_push_subscriptions',
  '0005_tags',
  '0006_completion_disposition',
  '0007_completed_in_block',
];

/** Apply one migration file the way drizzle's migrator does (statement-breakpoint split). */
async function applyMigration(sql: postgres.Sql, tag: string): Promise<void> {
  const file = readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf8');
  for (const stmt of file.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
    await sql.unsafe(stmt);
  }
}

const USER = '018f6d3e-0000-7000-8000-0000000000aa';

async function createDb(name: string): Promise<string> {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  return new URL(`/${name}`, adminUrl!).toString();
}
async function dropDb(name: string): Promise<void> {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

describe.skipIf(!adminUrl)('M3 — 0008 on a populated database', () => {
  const dbName = `prisms_m3_pop_${Date.now().toString(36)}`;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const url = await createDb(dbName);
    sql = postgres(url, { max: 1, onnotice: () => undefined });
    // bring the DB to the pre-0008 (v1.0) state, then populate it.
    for (const tag of PRE_0008) await applyMigration(sql, tag);
    await sql`INSERT INTO nodes (id, user_id, node_type, title, sort_order, updated_at)
              VALUES (gen_random_uuid(), ${USER}, 'vision', 'Legacy vision', 'a0', now())`;
    await sql`INSERT INTO sprints (id, user_id, title, starts_on, ends_on, updated_at)
              VALUES (gen_random_uuid(), ${USER}, 'Legacy sprint', '2026-06-01', '2026-06-30', now())`;
    await sql`INSERT INTO decision_boards (id, user_id, title, updated_at)
              VALUES (gen_random_uuid(), ${USER}, 'Legacy board', now())`;
  });

  afterAll(async () => {
    await sql?.end();
    await dropDb(dbName);
  });

  it('applies 0008 to the populated DB and preserves row counts', async () => {
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM nodes`;
    await applyMigration(sql, '0008_v13_convergence');
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM nodes`;
    expect(after[0]!.n).toBe(before[0]!.n); // additive — no row loss
    expect(before[0]!.n).toBe(1);
  });

  it('backfills legacy rows with the floor schema_version, sentinel hlc, and source_kind=legacy', async () => {
    const [node] = await sql`SELECT hlc, schema_version, source_kind, created_by_command_id, source_detail FROM nodes LIMIT 1`;
    expect(node!['hlc']).toBe('000000000000-0000-legacy');
    expect(node!['schema_version']).toBe(1);
    expect(node!['source_kind']).toBe('legacy'); // "origin unknown"
    expect(node!['created_by_command_id']).toBeNull();
    expect(node!['source_detail']).toEqual({});
    // the convergence columns reached the other populated tables too
    const [sprint] = await sql`SELECT source_kind, schema_version FROM sprints LIMIT 1`;
    expect(sprint!['source_kind']).toBe('legacy');
    const [board] = await sql`SELECT source_kind FROM decision_boards LIMIT 1`;
    expect(board!['source_kind']).toBe('legacy');
  });

  it('creates the new 1.3 tables and the schedule_blocks/automation extensions', async () => {
    const tables = (
      await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name);
    expect(tables).toContain('schedule_suggestion_batches');
    expect(tables).toContain('sync_review_items');
    const cols = (
      await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'schedule_blocks'`
    ).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['suggestion_batch_id', 'replaces_block_id', 'superseded_at', 'hlc', 'schema_version']));
  });
});

describe.skipIf(!adminUrl)('M3 — recreate after soft-delete (§7.7)', () => {
  const dbName = `prisms_m3_sd_${Date.now().toString(36)}`;
  let sql: postgres.Sql;
  const ids = {
    vision: '018f6d3e-0000-7000-8000-000000000101',
    roadmap: '018f6d3e-0000-7000-8000-000000000102',
    project: '018f6d3e-0000-7000-8000-000000000103',
    taskA: '018f6d3e-0000-7000-8000-000000000104',
    taskB: '018f6d3e-0000-7000-8000-000000000105',
    habit: '018f6d3e-0000-7000-8000-000000000106',
    sprint: '018f6d3e-0000-7000-8000-000000000107',
    board: '018f6d3e-0000-7000-8000-000000000108',
    criterion: '018f6d3e-0000-7000-8000-000000000109',
  };

  beforeAll(async () => {
    const url = await createDb(dbName);
    await runMigrations(url); // full chain incl. 0008
    sql = postgres(url, { max: 1, onnotice: () => undefined });
    const node = (id: string, type: string, parent: string | null, habit: string | null = null) =>
      sql`INSERT INTO nodes (id, user_id, node_type, title, sort_order, parent_id, habit_id, updated_at)
          VALUES (${id}, ${USER}, ${type}, ${type}, 'a0', ${parent}, ${habit}, now())`;
    await node(ids.vision, 'vision', null);
    await node(ids.roadmap, 'roadmap', ids.vision);
    await node(ids.project, 'project', ids.roadmap);
    await node(ids.taskA, 'task', ids.project);
    await node(ids.taskB, 'task', ids.project);
    await sql`INSERT INTO habits (id, user_id, vision_id, title, rrule, streak_mode, updated_at)
              VALUES (${ids.habit}, ${USER}, ${ids.vision}, 'h', 'FREQ=DAILY', 'daily', now())`;
    await sql`INSERT INTO sprints (id, user_id, title, starts_on, ends_on, updated_at)
              VALUES (${ids.sprint}, ${USER}, 's', '2026-06-01', '2026-06-30', now())`;
    await sql`INSERT INTO decision_boards (id, user_id, title, updated_at) VALUES (${ids.board}, ${USER}, 'b', now())`;
    await sql`INSERT INTO decision_criteria (id, user_id, board_id, label, weight, updated_at)
              VALUES (${ids.criterion}, ${USER}, ${ids.board}, 'c', 1, now())`;
  });

  afterAll(async () => {
    await sql?.end();
    await dropDb(dbName);
  });

  /** Insert a row, soft-delete every row in `table`, then re-insert the same key. */
  const recreates = async (table: string, insert: () => Promise<unknown>) => {
    await insert();
    await sql.unsafe(`UPDATE ${table} SET deleted_at = now()`);
    await expect(insert()).resolves.toBeDefined(); // partial unique permits recreate
  };

  it('edges: (predecessor_id, successor_id)', async () => {
    await recreates('edges', () =>
      sql`INSERT INTO edges (id, user_id, predecessor_id, successor_id, updated_at)
          VALUES (gen_random_uuid(), ${USER}, ${ids.taskA}, ${ids.taskB}, now())`,
    );
  });

  it('habit_completions: (habit_id, occurrence_date)', async () => {
    await recreates('habit_completions', () =>
      sql`INSERT INTO habit_completions (id, user_id, habit_id, occurrence_date, completed_at, updated_at)
          VALUES (gen_random_uuid(), ${USER}, ${ids.habit}, '2026-06-10', now(), now())`,
    );
  });

  it('sprint_memberships: (sprint_id, node_id)', async () => {
    await recreates('sprint_memberships', () =>
      sql`INSERT INTO sprint_memberships (id, user_id, sprint_id, node_id, updated_at)
          VALUES (gen_random_uuid(), ${USER}, ${ids.sprint}, ${ids.taskA}, now())`,
    );
  });

  it('decision_scores: (criterion_id, project_id)', async () => {
    await recreates('decision_scores', () =>
      sql`INSERT INTO decision_scores (id, user_id, criterion_id, project_id, score, updated_at)
          VALUES (gen_random_uuid(), ${USER}, ${ids.criterion}, ${ids.project}, 5, now())`,
    );
  });

  it('diagram_layouts: (diagram_id, node_id)', async () => {
    await recreates('diagram_layouts', () =>
      sql`INSERT INTO diagram_layouts (id, user_id, diagram_id, node_id, x, y, updated_at)
          VALUES (gen_random_uuid(), ${USER}, ${ids.project}, ${ids.taskA}, 0, 0, now())`,
    );
  });

  it('computed_aggregates: user-level (subject_id NULL) recreates under the dual index', async () => {
    const insert = () =>
      sql`INSERT INTO computed_aggregates (id, user_id, subject_kind, subject_id, metric, value, computed_at, computed_by, updated_at)
          VALUES (gen_random_uuid(), ${USER}, 'user', NULL, 'burndown_series', '{}'::jsonb, now(), 'server', now())`;
    await insert();
    await sql`UPDATE computed_aggregates SET deleted_at = now() WHERE subject_id IS NULL`;
    await expect(insert()).resolves.toBeDefined();
  });
});

/**
 * S13 DoD: clock-injected tests per job against a real Postgres (throwaway
 * DB). weather.poll upserts forecasts (injected fetch, no network);
 * aggregates.recompute overwrites a deliberately drifted client aggregate;
 * automation.backstop fills a missed spawn then no-ops on the already-spawned
 * row; retention.purge hard-deletes only rows past the 90-day cutoff.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { spawnedTaskId } from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';
import { runAggregatesRecompute } from '../src/jobs/aggregates-recompute';
import { runAutomationBackstop } from '../src/jobs/automation-backstop';
import { runRetentionPurge, RETENTION_DAYS } from '../src/jobs/retention-purge';
import { runWeatherPoll, locationSlug, type DailyForecast } from '../src/jobs/weather-poll';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

/** Fixed clock: noon (NY) on 2026-06-13. */
const NOW_MS = Date.parse('2026-06-13T16:00:00.000Z');
const clock = { now: () => NOW_MS };

let hlc = 0;
const cmd = (name: string, payload: unknown, id = randomUUID()) => ({
  id,
  name,
  hlc: `${(++hlc).toString(16).padStart(12, '0')}-0000-seed`,
  payload,
});

describe.skipIf(!adminUrl)('S13 jobs — facts & truth', () => {
  const dbName = `prisms_s13_${Date.now().toString(36)}`;
  let url: string;
  let sql_: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;

  const apply = async (userId: string, commands: ReturnType<typeof cmd>[]) => {
    const res = await dispatcher.handleUpload(userId, { device_id: 'seed', commands });
    if (res.kind !== 'ok') throw new Error(res.kind);
    return res.results;
  };

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql_ = postgres(url, { max: 6, onnotice: () => undefined });
    db = drizzle(sql_);
    dispatcher = createDispatcher(db, createRateLimiter({ limit: 100_000, windowMs: 60_000 }));
  });

  afterAll(async () => {
    await sql_?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('weather.poll upserts a forecast per user location (injected fetch)', async () => {
    const user = randomUUID();
    await apply(user, [
      cmd('settings.update', { weather_location: { lat: 28.36, lon: -80.69, label: 'Merritt Island, FL' } }),
    ]);
    const forecast: DailyForecast[] = [
      { date: '2026-06-13', high_c: 31, low_c: 24, precip_prob: 0.9, wind_kph: 18 },
      { date: '2026-06-14', high_c: 30, low_c: 23, precip_prob: 0.2, wind_kph: 12 },
    ];
    const res = await runWeatherPoll(db, clock, async () => forecast);
    expect(res).toEqual({ users: 1, facts: 2 });

    const slug = locationSlug('Merritt Island, FL');
    const rows = await sql_`SELECT key, payload, computed_at FROM external_facts WHERE user_id = ${user} ORDER BY key`;
    expect(rows.map((r) => r['key'])).toEqual([`${slug}/2026-06-13`, `${slug}/2026-06-14`]);
    expect((rows[0]!['payload'] as { precip_prob: number }).precip_prob).toBe(0.9);
    expect(new Date(rows[0]!['computed_at'] as string).getTime()).toBe(NOW_MS);

    // re-poll upserts in place (no duplicates)
    await runWeatherPoll(db, clock, async () => forecast);
    const count = await sql_`SELECT count(*)::int AS n FROM external_facts WHERE user_id = ${user}`;
    expect(count[0]!['n']).toBe(2);
  });

  it('aggregates.recompute overwrites a drifted client aggregate (DoD)', async () => {
    const user = randomUUID();
    const vision = randomUUID();
    const habit = randomUUID();
    await apply(user, [
      cmd('node.create', { id: vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('habit.create', { id: habit, vision_id: vision, title: 'Run', rrule: 'FREQ=DAILY', streak_mode: 'daily' }),
      cmd('habit.check_off', { id: randomUUID(), habit_id: habit, occurrence_date: '2026-06-11', completed_at: '2026-06-11T12:00:00.000Z' }),
      cmd('habit.check_off', { id: randomUUID(), habit_id: habit, occurrence_date: '2026-06-12', completed_at: '2026-06-12T12:00:00.000Z' }),
      cmd('habit.check_off', { id: randomUUID(), habit_id: habit, occurrence_date: '2026-06-13', completed_at: '2026-06-13T12:00:00.000Z' }),
    ]);
    // anchor the habit before the completions so its occurrences exist
    await sql_`UPDATE habits SET created_at = '2026-06-01T00:00:00Z' WHERE id = ${habit}`;

    // first canonical pass → the server's truth
    await runAggregatesRecompute(db, user, clock);
    const [truth] = await sql_`SELECT value, computed_by FROM computed_aggregates WHERE subject_id = ${habit} AND metric = 'streak'`;
    expect(truth!['computed_by']).toBe('server');
    const canonicalStreak = (truth!['value'] as { current: number }).current;

    // a client writes a drifted value
    const drifted = JSON.stringify({ current: 999, longest: 999, priorRun: 999, computedThrough: '2026-06-13' });
    await sql_`
      UPDATE computed_aggregates
      SET value = ${drifted}::jsonb, computed_by = 'client'
      WHERE subject_id = ${habit} AND metric = 'streak'`;

    // recompute heals it
    await runAggregatesRecompute(db, user, clock);
    const [healed] = await sql_`SELECT value, computed_by FROM computed_aggregates WHERE subject_id = ${habit} AND metric = 'streak'`;
    expect(healed!['computed_by']).toBe('server');
    expect((healed!['value'] as { current: number }).current).toBe(canonicalStreak);
    expect(canonicalStreak).not.toBe(999);
  });

  it('aggregates.recompute does NOT clobber a value written after its snapshot (§7.4 guard)', async () => {
    const user = randomUUID();
    const vision = randomUUID();
    const habit = randomUUID();
    await apply(user, [
      cmd('node.create', { id: vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('habit.create', { id: habit, vision_id: vision, title: 'Run', rrule: 'FREQ=DAILY', streak_mode: 'daily' }),
      cmd('habit.check_off', { id: randomUUID(), habit_id: habit, occurrence_date: '2026-06-13', completed_at: '2026-06-13T12:00:00.000Z' }),
    ]);
    await sql_`UPDATE habits SET created_at = '2026-06-01T00:00:00Z' WHERE id = ${habit}`;
    await runAggregatesRecompute(db, user, clock); // establish the server row

    // a later command writes a fresher value, stamped AFTER this run's snapshot.
    const fresh = JSON.stringify({ current: 42, longest: 42, priorRun: 0, computedThrough: '2026-06-13' });
    const future = new Date(NOW_MS + 60_000).toISOString();
    await sql_`
      UPDATE computed_aggregates SET value = ${fresh}::jsonb, computed_by = 'client', updated_at = ${future}
      WHERE subject_id = ${habit} AND metric = 'streak'`;

    // recompute must NOT clobber it — the guard skips a row written after the snapshot.
    await runAggregatesRecompute(db, user, clock);
    const [kept] = await sql_`SELECT value, computed_by FROM computed_aggregates WHERE subject_id = ${habit} AND metric = 'streak'`;
    expect((kept!['value'] as { current: number }).current).toBe(42); // the later write survived
    expect(kept!['computed_by']).toBe('client');
  });

  it('automation.backstop fills a missed spawn, then no-ops on the already-spawned row (DoD)', async () => {
    const user = randomUUID();
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID(), rule: randomUUID() };
    await apply(user, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.task, node_type: 'task', title: 'Lecture', sort_order: 'a0', parent_id: ids.project }),
      cmd('rule.create', {
        id: ids.rule,
        trigger: 'task_completed',
        conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Pre-brief: {trigger.title}', parent: 'same_as_trigger' } }],
      }),
      cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T14:00:00.000Z' }),
    ]);

    // §10.1: node.check_off ran automation IN ITS txn — the follow-up already exists.
    const spawned = await sql_`SELECT title, parent_id, source_kind FROM nodes WHERE user_id = ${user} AND title = 'Pre-brief: Lecture'`;
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!['parent_id']).toBe(ids.project); // parent: same_as_trigger
    expect(spawned[0]!['source_kind']).toBe('automation');

    // the backstop is now a no-op safety-net: the row is already present (UUIDv5).
    const first = await runAutomationBackstop(db, { userId: user, trigger: 'task_completed', nodeId: ids.task });
    expect(first.nodesInserted).toBe(0);
    expect(first.noop).toBe(true);
    const stillOne = await sql_`SELECT count(*)::int AS n FROM nodes WHERE user_id = ${user} AND title = 'Pre-brief: Lecture'`;
    expect(stillOne[0]!['n']).toBe(1);
  });

  it('automation.backstop fills a missed spawn and raises an automation_backstop item (§10.2 offline gap)', async () => {
    const user = randomUUID();
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID(), rule: randomUUID() };
    await apply(user, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.task, node_type: 'task', title: 'Lecture', sort_order: 'a0', parent_id: ids.project }),
      cmd('rule.create', {
        id: ids.rule,
        trigger: 'task_completed',
        conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Pre-brief: {trigger.title}', parent: 'same_as_trigger' } }],
      }),
    ]);
    // an offline device completed the task elsewhere; this server's in-txn automation never ran for it.
    await sql_`UPDATE nodes SET completed_at = '2026-06-13T14:00:00.000Z' WHERE id = ${ids.task}`;

    const res = await runAutomationBackstop(db, { userId: user, trigger: 'task_completed', nodeId: ids.task });
    expect(res.nodesInserted).toBe(1);
    expect(res.noop).toBe(false);
    const spawned = await sql_`SELECT parent_id, source_kind, source_id, source_detail FROM nodes WHERE user_id = ${user} AND title = 'Pre-brief: Lecture'`;
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ parent_id: ids.project, source_kind: 'automation', source_id: ids.rule });
    expect(spawned[0]!['source_detail']).toMatchObject({ backstop: true, trigger_node_id: ids.task });
    const items = await sql_`SELECT severity, detail FROM sync_review_items WHERE user_id = ${user} AND item_type = 'automation_backstop'`;
    expect(items).toHaveLength(1);
    expect(items[0]!['severity']).toBe('info');
    expect((items[0]!['detail'] as { filled_ids: string[] }).filled_ids).toContain(spawnedTaskId(ids.rule, ids.task, 0));
  });

  it('automation.backstop raises an automation_drift item and does NOT overwrite a divergent row at the deterministic id (§10.2)', async () => {
    const user = randomUUID();
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID(), rule: randomUUID() };
    const spawnId = spawnedTaskId(ids.rule, ids.task, 0);
    await apply(user, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.task, node_type: 'task', title: 'Lecture', sort_order: 'a0', parent_id: ids.project }),
      cmd('rule.create', {
        id: ids.rule,
        trigger: 'task_completed',
        conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Pre-brief: {trigger.title}', parent: 'same_as_trigger' } }],
      }),
      // a divergent row already occupies the deterministic id (an older template version / a colliding user row).
      cmd('node.create', { id: spawnId, node_type: 'task', title: 'OLD: Lecture', sort_order: 'a1', parent_id: ids.project }),
    ]);
    await sql_`UPDATE nodes SET completed_at = '2026-06-13T14:00:00.000Z' WHERE id = ${ids.task}`;

    const res = await runAutomationBackstop(db, { userId: user, trigger: 'task_completed', nodeId: ids.task });
    expect(res.nodesInserted).toBe(0); // the id is present, so nothing is inserted
    expect(res.driftItems).toBe(1);
    expect(res.noop).toBe(false);
    // §10.2: keep the existing row, do NOT overwrite.
    const [row] = await sql_`SELECT title FROM nodes WHERE id = ${spawnId}`;
    expect(row!['title']).toBe('OLD: Lecture');
    const items = await sql_`SELECT severity, detail FROM sync_review_items WHERE user_id = ${user} AND item_type = 'automation_drift'`;
    expect(items).toHaveLength(1);
    expect(items[0]!['severity']).toBe('info');
    const d = items[0]!['detail'] as { id: string; existing_content_hash: string; spawned_content_hash: string };
    expect(d.id).toBe(spawnId);
    expect(d.existing_content_hash).not.toBe(d.spawned_content_hash); // content genuinely diverged
  });

  it('retention.purge hard-deletes only rows past the 90-day cutoff (clock-injected)', async () => {
    const user = randomUUID();
    const oldSprint = randomUUID();
    const recentSprint = randomUUID();
    const oldDeleted = new Date(NOW_MS - (RETENTION_DAYS + 5) * 86_400_000).toISOString();
    const recentDeleted = new Date(NOW_MS - 5 * 86_400_000).toISOString();
    await sql_`INSERT INTO sprints (id, user_id, title, starts_on, ends_on, updated_at, deleted_at)
      VALUES (${oldSprint}, ${user}, 'old', '2026-01-01', '2026-01-07', ${oldDeleted}, ${oldDeleted}),
             (${recentSprint}, ${user}, 'recent', '2026-06-01', '2026-06-07', ${recentDeleted}, ${recentDeleted})`;
    // an old soft-deleted node with no references is purged too
    const oldNode = randomUUID();
    await sql_`INSERT INTO nodes (id, user_id, node_type, title, sort_order, updated_at, deleted_at)
      VALUES (${oldNode}, ${user}, 'activity', 'gone', 'a0', ${oldDeleted}, ${oldDeleted})`;

    const res = await runRetentionPurge(db, clock);
    expect(res.deleted['sprints']).toBeGreaterThanOrEqual(1);
    expect(res.deleted['nodes']).toBeGreaterThanOrEqual(1);

    const sprintsLeft = await sql_`SELECT id FROM sprints WHERE user_id = ${user}`;
    expect(sprintsLeft.map((r) => r['id'])).toEqual([recentSprint]); // recent survives
    const nodeGone = await sql_`SELECT count(*)::int AS n FROM nodes WHERE id = ${oldNode}`;
    expect(nodeGone[0]!['n']).toBe(0);
  });
});

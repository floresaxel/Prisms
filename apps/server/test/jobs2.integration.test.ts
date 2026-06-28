/**
 * S14 DoD: scheduling + notify jobs vs real Postgres. schedule.optimize emits
 * only diffs (a task already committed at its optimum gets no suggestion);
 * pastdue.scan yields exactly one suggestion row per past-due task + a
 * notification; layout.precompute fills diagram_layouts for the seed roadmap;
 * notify.dispatch routes to mocked push adapters.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { DEMO_USER_ID, loadRootEnv, runMigrations, seedDemoUser } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportManifestSchema } from '@prisms/core';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';
import { runBackupSnapshot } from '../src/jobs/backup-snapshot';
import { runImportValidate } from '../src/jobs/import-validate';
import { runScheduleOptimize, NIGHTLY_OPTIMIZATION } from '../src/jobs/schedule-optimize';
import { runPastdueScan, PAST_DUE_RESCHEDULE, type PastDueNotification } from '../src/jobs/pastdue-scan';
import { runLayoutPrecompute } from '../src/jobs/layout-precompute';
import { runNotifyDispatch } from '../src/jobs/notify-dispatch';
import type { PushAdapter, PushNotification, PushTarget } from '../src/jobs/push';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const NOW_MS = Date.parse('2026-06-13T16:00:00.000Z');
const clock = { now: () => NOW_MS };

let hlc = 0;
const cmd = (name: string, payload: unknown, id = randomUUID()) => ({
  id,
  name,
  hlc: `${(++hlc).toString(16).padStart(12, '0')}-0000-seed`,
  payload,
});

describe.skipIf(!adminUrl)('S14 jobs — scheduling & notify', () => {
  const dbName = `prisms_s14_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;

  const apply = async (userId: string, commands: ReturnType<typeof cmd>[]) => {
    const res = await dispatcher.handleUpload(userId, { device_id: 'seed', commands });
    if (res.kind !== 'ok') throw new Error(res.kind);
    return res.results;
  };

  /** A project with `n` 60-minute tasks, for a fresh user. */
  async function projectWithTasks(n: number) {
    const user = randomUUID();
    const ids = { user, vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), tasks: [] as string[] };
    const commands = [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
    ];
    for (let i = 0; i < n; i += 1) {
      const t = randomUUID();
      ids.tasks.push(t);
      commands.push(cmd('node.create', { id: t, node_type: 'task', title: `T${i}`, sort_order: `a${i}`, parent_id: ids.project, estimate_minutes: 60 }));
    }
    await apply(user, commands);
    return ids;
  }

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

  it('schedule.optimize emits only diffs vs the committed plan (DoD)', async () => {
    const ids = await projectWithTasks(2);
    const first = await runScheduleOptimize(db, ids.user, clock);
    expect(first.suggestions).toBe(2); // both unscheduled tasks proposed
    expect(first.batchId).not.toBeNull();
    // §7.5/§7.8: the suggestions belong to the batch and carry scheduler provenance.
    const firstBlocks = await sql`
      SELECT suggestion_batch_id, source_kind, source_id FROM schedule_blocks
      WHERE user_id = ${ids.user} AND status = 'suggested' AND suggestion_reason = ${NIGHTLY_OPTIMIZATION}`;
    expect(firstBlocks).toHaveLength(2);
    expect(firstBlocks.every((b) => b['suggestion_batch_id'] === first.batchId && b['source_kind'] === 'scheduler' && b['source_id'] === first.batchId)).toBe(true);

    // commit one task at exactly its suggested slot, then re-optimize
    const taskAId = ids.tasks[0]!;
    const [taskA] = await sql`
      SELECT task_id, starts_at, ends_at FROM schedule_blocks
      WHERE user_id = ${ids.user} AND status = 'suggested' AND task_id = ${taskAId}`;
    await sql`INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, updated_at)
      VALUES (${randomUUID()}, ${ids.user}, ${taskA!['task_id']}, ${taskA!['starts_at']}, ${taskA!['ends_at']}, 'none', 'committed', ${new Date(NOW_MS).toISOString()})`;

    const second = await runScheduleOptimize(db, ids.user, clock);
    expect(second.suggestions).toBe(1); // taskA matches its committed block ⇒ no diff
    expect(second.batchId).not.toBe(first.batchId);
    // §7.5: the newer batch supersedes the older; the new one is active.
    const [oldBatch] = await sql`SELECT superseded_at FROM schedule_suggestion_batches WHERE id = ${first.batchId}`;
    expect(oldBatch!['superseded_at']).not.toBeNull();
    const [newBatch] = await sql`SELECT superseded_at FROM schedule_suggestion_batches WHERE id = ${second.batchId}`;
    expect(newBatch!['superseded_at']).toBeNull();

    const suggestedTasks = await sql`
      SELECT task_id, suggestion_batch_id FROM schedule_blocks
      WHERE user_id = ${ids.user} AND status = 'suggested' AND suggestion_reason = ${NIGHTLY_OPTIMIZATION}`;
    expect(suggestedTasks.map((r) => r['task_id'])).toEqual([ids.tasks[1]]);
    expect(suggestedTasks[0]!['suggestion_batch_id']).toBe(second.batchId); // links to the active batch
  });

  it('pastdue.scan yields exactly one suggestion row + a notification, idempotently (DoD)', async () => {
    const ids = await projectWithTasks(1);
    const task = ids.tasks[0]!;
    await apply(ids.user, [cmd('node.set_dates', { id: task, due_date: '2026-06-10' })]); // past due

    const notes: PastDueNotification[] = [];
    const first = await runPastdueScan(db, ids.user, clock, (n) => notes.push(n));
    expect(first.pastDue).toBe(1);
    expect(first.suggested).toBe(1);
    expect(notes).toEqual([{ userId: ids.user, taskId: task, title: 'T0' }]);

    const rows = await sql`
      SELECT id, starts_at, suggestion_batch_id, source_kind, source_id FROM schedule_blocks
      WHERE user_id = ${ids.user} AND task_id = ${task} AND status = 'suggested' AND suggestion_reason = ${PAST_DUE_RESCHEDULE}`;
    expect(rows).toHaveLength(1);
    // the replacement block is at or after "now"
    expect(new Date(rows[0]!['starts_at'] as string).getTime()).toBeGreaterThanOrEqual(NOW_MS);
    // §7.5/§7.8: the suggestion belongs to a past_due batch and carries scheduler provenance.
    expect(rows[0]!['source_kind']).toBe('scheduler');
    expect(rows[0]!['source_id']).toBe(rows[0]!['suggestion_batch_id']);
    const [batch] = await sql`SELECT source FROM schedule_suggestion_batches WHERE id = ${rows[0]!['suggestion_batch_id']}`;
    expect(batch!['source']).toBe('past_due');

    // re-scan: still exactly one suggestion (idempotent)
    const second = await runPastdueScan(db, ids.user, clock);
    expect(second.suggested).toBe(0);
    const after = await sql`
      SELECT count(*)::int AS n FROM schedule_blocks
      WHERE user_id = ${ids.user} AND task_id = ${task} AND status = 'suggested' AND deleted_at IS NULL`;
    expect(after[0]!['n']).toBe(1);
  });

  it('layout.precompute fills diagram_layouts for the seed roadmap (DoD)', async () => {
    await seedDemoUser(url);
    const [roadmap] = await sql`
      SELECT id FROM nodes WHERE user_id = ${DEMO_USER_ID} AND node_type = 'roadmap' AND title = 'Prisms v1'`;
    const diagramId = roadmap!['id'] as string;

    const res = await runLayoutPrecompute(db, { userId: DEMO_USER_ID, diagramId }, clock);
    expect(res.nodesLaidOut).toBeGreaterThan(0);

    const layouts = await sql`SELECT node_id, x, y, computed_at FROM diagram_layouts WHERE diagram_id = ${diagramId}`;
    expect(layouts.length).toBe(res.nodesLaidOut);
    // ELK assigned real coordinates and stamped computed_at
    expect(layouts.every((l) => typeof l['x'] === 'number' && typeof l['y'] === 'number')).toBe(true);
    expect(layouts.every((l) => l['computed_at'] !== null)).toBe(true);
    // re-run upserts in place (no duplicate rows)
    await runLayoutPrecompute(db, { userId: DEMO_USER_ID, diagramId }, clock);
    const again = await sql`SELECT count(*)::int AS n FROM diagram_layouts WHERE diagram_id = ${diagramId}`;
    expect(again[0]!['n']).toBe(res.nodesLaidOut);
  });

  it('notify.dispatch routes each subscription to its push adapter (DoD: mocked)', async () => {
    const user = randomUUID();
    const webKeys = JSON.stringify({ p256dh: 'k', auth: 'a' });
    const stamp = new Date(NOW_MS).toISOString();
    await sql`INSERT INTO push_subscriptions (id, user_id, device_id, kind, endpoint, keys, updated_at) VALUES
      (${randomUUID()}, ${user}, 'browser', 'web', 'https://push.example/abc', ${webKeys}::jsonb, ${stamp}),
      (${randomUUID()}, ${user}, 'phone', 'expo', 'ExponentPushToken[xyz]', NULL, ${stamp})`;

    const calls: { kind: string; target: PushTarget; notification: PushNotification }[] = [];
    const mock = (kind: 'web' | 'expo'): PushAdapter => ({
      kind,
      send: async (target, notification) => {
        calls.push({ kind, target, notification });
        return { ok: true };
      },
    });

    const notification: PushNotification = { title: 'Task overdue', body: 'reschedule', data: { taskId: 'x' } };
    const res = await runNotifyDispatch(db, { userId: user, notification }, { web: mock('web'), expo: mock('expo') });

    expect(res).toEqual({ targets: 2, sent: 2, failed: 0 });
    expect(calls.map((c) => c.kind).sort()).toEqual(['expo', 'web']);
    const web = calls.find((c) => c.kind === 'web')!;
    expect(web.target.endpoint).toBe('https://push.example/abc');
    expect(web.target.keys).toEqual({ p256dh: 'k', auth: 'a' });
    expect(web.notification).toEqual(notification);
    expect(calls.find((c) => c.kind === 'expo')!.target.endpoint).toBe('ExponentPushToken[xyz]');
  });

  it('backup.snapshot exports portable rows; import.validate dry-runs without writing data (§13.1)', async () => {
    const ids = await projectWithTasks(2);
    const manifest = await runBackupSnapshot(db, ids.user, clock);
    expect(exportManifestSchema.safeParse(manifest).success).toBe(true); // a valid prisms-export
    expect(manifest.format).toBe('prisms-export');
    expect(manifest.tables['nodes']!.length).toBeGreaterThanOrEqual(5); // vision+roadmap+project+2 tasks

    const nodesBefore = (await sql`SELECT count(*)::int AS n FROM nodes WHERE user_id = ${ids.user}`)[0]!['n'];

    // re-importing the SAME data → every id collides; the dry-run reports + warns, writes no data.
    const report = await runImportValidate(db, ids.user, manifest, clock);
    expect(report.format_ok).toBe(true);
    expect(report.conflicts.length).toBeGreaterThanOrEqual(5);
    expect(report.conflicts.every((c) => c.reason.includes('already exists'))).toBe(true);
    const nodesAfter = (await sql`SELECT count(*)::int AS n FROM nodes WHERE user_id = ${ids.user}`)[0]!['n'];
    expect(nodesAfter).toBe(nodesBefore); // dry-run wrote no data rows

    const items = await sql`SELECT severity FROM sync_review_items WHERE user_id = ${ids.user} AND item_type = 'import_warning'`;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!['severity']).toBe('warning');
  });

  it('import.validate flags a malformed manifest with an import_warning (§13.1)', async () => {
    const user = randomUUID();
    const report = await runImportValidate(db, user, { format: 'not-prisms', garbage: true }, clock);
    expect(report.format_ok).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
    const items = await sql`SELECT count(*)::int AS n FROM sync_review_items WHERE user_id = ${user} AND item_type = 'import_warning'`;
    expect(items[0]!['n']).toBe(1);
  });
});

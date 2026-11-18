/**
 * Long sessions vs real Postgres: timer.long_session_scan flags > 6 h sessions
 * (running or closed), clocks out > 24 h ones at exactly start + 24 h, is
 * idempotent, supersedes the 6 h item on auto clock-out; timer.adjust fixes a
 * closed session's end and refuses a running one.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { runLongSessionScan, runLongSessionScanAll, type LongSessionNotification } from '../src/jobs/long-session-scan';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const H = 3_600_000;
const NOW_MS = Date.parse('2026-06-13T16:00:00.000Z');
const ago = (hours: number) => new Date(NOW_MS - hours * H).toISOString();

let hlc = 0;
const cmd = (name: string, payload: unknown, id = randomUUID()) => ({
  id,
  name,
  hlc: `${(++hlc).toString(16).padStart(12, '0')}-0000-seed`,
  payload,
  schema_version: 1,
});

describe.skipIf(!adminUrl)('long sessions (> 6 h review, > 24 h auto clock-out)', () => {
  const dbName = `prisms_longsess_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;

  const apply = async (userId: string, commands: ReturnType<typeof cmd>[]) => {
    const res = await dispatcher.handleUpload(userId, { device_id: 'seed', commands });
    if (res.kind !== 'ok') throw new Error(res.kind);
    return res.results;
  };

  async function tasks(n: number) {
    const user = randomUUID();
    const vision = randomUUID();
    const roadmap = randomUUID();
    const project = randomUUID();
    const ids: string[] = [];
    const commands = [
      cmd('node.create', { id: vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: vision }),
      cmd('node.create', { id: project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: roadmap }),
    ];
    for (let i = 0; i < n; i += 1) {
      const t = randomUUID();
      ids.push(t);
      commands.push(cmd('node.create', { id: t, node_type: 'task', title: `Task ${i}`, sort_order: `a${i}`, parent_id: project }));
    }
    await apply(user, commands);
    return { user, tasks: ids };
  }

  const items = (userId: string) =>
    sql`SELECT id, status, severity, title, detail FROM sync_review_items WHERE user_id = ${userId} AND item_type = 'long_session' ORDER BY created_at, id`;
  const endOf = async (entryId: string) => {
    const [row] = await sql`SELECT ended_at FROM time_entries WHERE id = ${entryId}`;
    return row!['ended_at'] === null ? null : new Date(row!['ended_at'] as string).toISOString();
  };

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

  it('flags > 6 h, auto clocks out > 24 h at start + 24 h, notifies only when it still matters, and is idempotent', async () => {
    const { user, tasks: [t0, t1, t2, t3] } = await tasks(4);
    const [e0, e1, e2, e3] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await apply(user, [
      cmd('timer.clock_in', { entry_id: e0, task_id: t0, started_at: ago(7) }), // running 7 h → over_6h
      cmd('timer.clock_in', { entry_id: e1, task_id: t1, started_at: ago(30) }), // running 30 h → auto clock-out
      cmd('timer.clock_in', { entry_id: e2, task_id: t2, started_at: ago(12) }),
      cmd('timer.clock_out', { entry_id: e2, ended_at: ago(4) }), // closed, ran 8 h → over_6h (no push)
      cmd('timer.clock_in', { entry_id: e3, task_id: t3, started_at: ago(2) }), // fine
    ]);

    const pushed: LongSessionNotification[] = [];
    const first = await runLongSessionScan(db, user, { now: () => NOW_MS }, (n) => pushed.push(n));
    expect(first).toEqual({ flagged: 3, autoClosed: 1, superseded: 0 });

    expect(await endOf(e1)).toBe(new Date(Date.parse(ago(30)) + 24 * H).toISOString());
    expect(await endOf(e0)).toBeNull();
    expect(await endOf(e3)).toBeNull();

    const rows = await items(user);
    const byEntry = new Map(rows.map((r) => [(r['detail'] as { entry_id: string }).entry_id, r]));
    expect((byEntry.get(e0)!['detail'] as { kind: string }).kind).toBe('over_6h');
    expect((byEntry.get(e1)!['detail'] as { kind: string }).kind).toBe('auto_clock_out');
    expect((byEntry.get(e2)!['detail'] as { kind: string }).kind).toBe('over_6h');
    expect(byEntry.has(e3)).toBe(false);
    expect(byEntry.get(e1)!['title']).toContain('Task 1');
    expect(rows.every((r) => r['status'] === 'open' && r['severity'] === 'warning')).toBe(true);
    expect(pushed.map((p) => `${p.taskId}:${p.kind}`).sort()).toEqual([`${t0}:over_6h`, `${t1}:auto_clock_out`].sort());

    // idempotent: nothing new on a re-scan
    expect(await runLongSessionScan(db, user, { now: () => NOW_MS })).toEqual({ flagged: 0, autoClosed: 0, superseded: 0 });

    // still running 20 h later → auto clock-out, and the open 6 h item is superseded
    const later = await runLongSessionScan(db, user, { now: () => NOW_MS + 20 * H });
    expect(later).toMatchObject({ autoClosed: 1, superseded: 1 });
    expect(await endOf(e0)).toBe(new Date(Date.parse(ago(7)) + 24 * H).toISOString());
    const after = await items(user);
    const e0Items = after.filter((r) => (r['detail'] as { entry_id: string }).entry_id === e0);
    expect(e0Items.map((r) => `${(r['detail'] as { kind: string }).kind}:${r['status']}`).sort()).toEqual(['auto_clock_out:open', 'over_6h:dismissed']);
  });

  it('the all-users entry point only visits users with a candidate session', async () => {
    const quiet = await tasks(1);
    await apply(quiet.user, [cmd('timer.clock_in', { entry_id: randomUUID(), task_id: quiet.tasks[0], started_at: ago(1) })]);
    const outcome = await runLongSessionScanAll(db, { now: () => NOW_MS });
    expect(outcome.failed).toBe(0);
    expect((await items(quiet.user)).length).toBe(0);
  });

  it('timer.adjust corrects a closed session and refuses a running one or a bad end', async () => {
    const { user, tasks: [t0, t1] } = await tasks(2);
    const closed = randomUUID();
    const running = randomUUID();
    await apply(user, [
      cmd('timer.clock_in', { entry_id: closed, task_id: t0, started_at: ago(30) }),
      cmd('timer.clock_out', { entry_id: closed, ended_at: ago(6) }),
      cmd('timer.clock_in', { entry_id: running, task_id: t1, started_at: ago(8) }),
    ]);

    const [ok] = await apply(user, [cmd('timer.adjust', { entry_id: closed, ended_at: ago(21) })]);
    expect(ok).toMatchObject({ result: 'applied' });
    expect(await endOf(closed)).toBe(ago(21));

    const [stillRunning] = await apply(user, [cmd('timer.adjust', { entry_id: running, ended_at: ago(1) })]);
    expect(stillRunning).toMatchObject({ result: 'rejected', reject_code: 'E_TIMER_ALREADY_RUNNING' });
    const [beforeStart] = await apply(user, [cmd('timer.adjust', { entry_id: closed, ended_at: ago(31) })]);
    expect(beforeStart).toMatchObject({ result: 'rejected', reject_code: 'E_INVALID_INTERVAL' });
    const [future] = await apply(user, [cmd('timer.adjust', { entry_id: closed, ended_at: new Date(Date.now() + 3 * H).toISOString() })]);
    expect(future).toMatchObject({ result: 'rejected', reject_code: 'E_INVALID_INTERVAL' });

    // someone else's entry
    const [foreign] = await apply(randomUUID(), [cmd('timer.adjust', { entry_id: closed, ended_at: ago(20) })]);
    expect(foreign).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });
});

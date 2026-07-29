/**
 * V2 — Annex L on the server: `settings.update {journal_day_log}` through the
 * real dispatcher + Postgres, and the export-time day-log composition.
 *
 * What it pins:
 *  - the flag round-trips through HLC-LWW and PERSISTS (this fails if the
 *    dispatcher's explicit `settings.update` candidate list omits the field —
 *    the command would apply as a silent no-op);
 *  - flag OFF ⇒ the export response is byte-identical to the pre-Annex-L one
 *    (golden string comparison, not a shape check);
 *  - flag ON ⇒ each day carries its derived log, LOG-ONLY days join the
 *    response, and the seeded past-month log-only day is there;
 *  - the D2 membership rules survive the round trip: suggested / superseded /
 *    soft-deleted blocks excluded, deleted nodes excluded, done / planned /
 *    disposition / truncation correct, owner-scoped, emoji titles byte-exact;
 *  - flipping the flag back ON restores everything completed while it was off —
 *    there is no catch-up machinery because it is a recomputation.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { DEMO_USER_ID, loadRootEnv, runMigrations, seedDemoUser } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher, type UploadResponse } from '../src/dispatcher';
import { runJournalExport, type JournalExportEntry } from '../src/jobs/journal-export';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const ZWJ = '👨‍👩‍👧‍👦';
const hlcOf = (n: number, device = 'deva') => `${n.toString(16).padStart(12, '0')}-0000-${device}`;

describe.skipIf(!adminUrl)('V2 journal day log — settings + export', () => {
  const dbName = `prisms_v2_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;
  let hc = 0;
  const hlc = () => hlcOf(++hc);

  const ok = (res: UploadResponse) => {
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
    return res.results;
  };
  const setFlag = (userId: string, value: boolean, at = hlc()) =>
    dispatcher.handleUpload(userId, {
      device_id: 'deva',
      commands: [{ id: randomUUID(), name: 'settings.update', hlc: at, payload: { journal_day_log: value }, schema_version: 1 }],
    });
  const writeNote = (userId: string, entry_date: string, content: string) =>
    dispatcher.handleUpload(userId, {
      device_id: 'deva',
      commands: [{ id: randomUUID(), name: 'journal.write', hlc: hlc(), payload: { id: randomUUID(), entry_date, content }, schema_version: 1 }],
    });

  /** Facts go in as rows: the export reads the DB, and SQL keeps the fixture explicit. */
  async function task(
    userId: string,
    title: string,
    over: { completed_at?: string; disposition?: string; deleted_at?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO nodes (id, user_id, node_type, title, sort_order, updated_at, completed_at, completion_disposition, deleted_at)
      VALUES (${id}, ${userId}, 'task', ${title}, ${`a${id.slice(0, 4)}`}, now(),
              ${over.completed_at ?? null}, ${over.disposition ?? null}, ${over.deleted_at ?? null})`;
    return id;
  }
  async function block(
    userId: string,
    taskId: string,
    starts: string,
    ends: string,
    over: { status?: string; superseded_at?: string; deleted_at?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, status, superseded_at, deleted_at, updated_at)
      VALUES (${id}, ${userId}, ${taskId}, ${starts}, ${ends}, ${over.status ?? 'committed'},
              ${over.superseded_at ?? null}, ${over.deleted_at ?? null}, now())`;
    return id;
  }
  const byDate = (entries: JournalExportEntry[]) => new Map(entries.map((e) => [e.entry_date, e]));

  // UTC settings keep the fixtures readable: with day_reset_hour 4 in UTC, an
  // instant at 12:00Z buckets to its own calendar date.
  async function utcSettings(userId: string): Promise<void> {
    await sql`
      INSERT INTO user_settings (user_id, day_reset_hour, timezone, updated_at)
      VALUES (${userId}, 4, 'UTC', now())
      ON CONFLICT (user_id) DO UPDATE SET day_reset_hour = 4, timezone = 'UTC'`;
  }

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    db = drizzle(sql);
    dispatcher = createDispatcher(db, createRateLimiter({ limit: 100_000, windowMs: 60_000 }), {
      enqueueBackstop: () => undefined,
    });
  });

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('settings.update {journal_day_log} round-trips through LWW and PERSISTS', async () => {
    const user = randomUUID();
    ok(await setFlag(user, false));
    const [off] = await sql`SELECT journal_day_log FROM user_settings WHERE user_id = ${user}`;
    expect(off!['journal_day_log']).toBe(false); // fails if the dispatcher candidate list omits it
    ok(await setFlag(user, true));
    const [on] = await sql`SELECT journal_day_log FROM user_settings WHERE user_id = ${user}`;
    expect(on!['journal_day_log']).toBe(true);
    // …and a STRICTLY OLDER writer loses: the flag is an ordinary LWW field.
    ok(await setFlag(user, false, hlcOf(1, 'devb')));
    const [still] = await sql`SELECT journal_day_log FROM user_settings WHERE user_id = ${user}`;
    expect(still!['journal_day_log']).toBe(true);
  });

  it('a settings row that never names the flag reads as ON (opt-out default)', async () => {
    const user = randomUUID();
    await utcSettings(user);
    const [row] = await sql`SELECT journal_day_log FROM user_settings WHERE user_id = ${user}`;
    expect(row!['journal_day_log']).toBe(true);
  });

  it('flag ON: a day carries BOTH its note and its log, and log-only days join in', async () => {
    const user = randomUUID();
    await utcSettings(user);
    ok(await writeNote(user, '2026-05-08', 'wrote something 🚀'));
    const noted = await task(user, `retro ${ZWJ}`, { completed_at: '2026-05-08T18:20:00.000Z' });
    await block(user, noted, '2026-05-08T17:00:00.000Z', '2026-05-08T18:30:00.000Z');
    const logOnly = await task(user, 'quiet day work', { completed_at: '2026-05-09T15:00:00.000Z' });
    expect(logOnly).toBeTruthy();

    const entries = await runJournalExport(db, user);
    const days = byDate(entries);
    expect([...days.keys()]).toEqual(['2026-05-08', '2026-05-09']); // date-ordered

    const withNote = days.get('2026-05-08')!;
    expect(withNote.content).toBe('wrote something 🚀');
    expect(withNote.updated_at).toBeTypeOf('string');
    expect(withNote.day_log!.scheduled).toHaveLength(1);
    expect(withNote.day_log!.scheduled[0]!.title).toBe(`retro ${ZWJ}`); // emoji byte-exact
    expect(withNote.day_log!.scheduled[0]!.done).toBe(true);
    expect(withNote.day_log!.completed[0]!.planned).toBe(true);

    const noNote = days.get('2026-05-09')!;
    expect(noNote.content).toBe(''); // a LOG-ONLY day
    expect(noNote.updated_at).toBeUndefined(); // there is no note row to stamp
    expect(noNote.day_log!.completed.map((c) => c.title)).toEqual(['quiet day work']);
  });

  it('flag OFF: the response is BYTE-IDENTICAL to the pre-Annex-L shape', async () => {
    const user = randomUUID();
    await utcSettings(user);
    ok(await writeNote(user, '2026-05-08', 'a note'));
    const t = await task(user, 'done thing', { completed_at: '2026-05-08T18:20:00.000Z' });
    await block(user, t, '2026-05-08T17:00:00.000Z', '2026-05-08T18:30:00.000Z');
    await task(user, 'log-only thing', { completed_at: '2026-05-09T15:00:00.000Z' });

    ok(await setFlag(user, false));
    const off = await runJournalExport(db, user);
    // the golden: exactly what the endpoint returned before this feature existed
    const legacy = await sql`
      SELECT entry_date, content, updated_at FROM journal_entries
      WHERE user_id = ${user} AND deleted_at IS NULL ORDER BY entry_date`;
    expect(JSON.stringify(off)).toBe(
      JSON.stringify(legacy.map((r) => ({ entry_date: r['entry_date'], content: r['content'], updated_at: r['updated_at'] }))),
    );
    expect(off.some((e) => 'day_log' in e)).toBe(false);
    expect(off.map((e) => e.entry_date)).toEqual(['2026-05-08']); // no log-only day

    // flipping back ON restores everything, including what completed while it was
    // off — a recomputation, not a catch-up.
    ok(await setFlag(user, true));
    const on = await runJournalExport(db, user);
    expect(on.map((e) => e.entry_date)).toEqual(['2026-05-08', '2026-05-09']);
    expect(on.every((e) => e.day_log !== undefined)).toBe(true);
  });

  it('excludes suggested, superseded, and soft-deleted blocks, and deleted nodes', async () => {
    const user = randomUUID();
    await utcSettings(user);
    const live = await task(user, 'still here');
    const gone = await task(user, 'deleted task', { deleted_at: '2026-05-10T00:00:00.000Z' });
    const s = '2026-05-10T13:00:00.000Z';
    const e = '2026-05-10T14:00:00.000Z';
    await block(user, live, s, e, { status: 'suggested' });
    await block(user, live, s, e, { superseded_at: '2026-05-10T15:00:00.000Z' });
    await block(user, live, s, e, { deleted_at: '2026-05-10T15:00:00.000Z' });
    await block(user, gone, s, e);
    expect(await runJournalExport(db, user)).toEqual([]);
  });

  it('surfaces done / unplanned / descoped and the truncation counter', async () => {
    const user = randomUUID();
    await utcSettings(user);
    const day = '2026-05-11';
    const scheduledOpen = await task(user, 'not finished');
    await block(user, scheduledOpen, `${day}T13:00:00.000Z`, `${day}T14:00:00.000Z`);
    await task(user, 'ad-hoc', { completed_at: `${day}T15:00:00.000Z` });
    await task(user, 'dead idea', { completed_at: `${day}T16:00:00.000Z`, disposition: 'obsolete' });
    // 101 completions on ONE day → the cap drops exactly one.
    const flood = '2026-05-12';
    for (let i = 0; i < 101; i += 1) {
      await task(user, `flood ${i}`, { completed_at: `${flood}T12:00:${String(i % 60).padStart(2, '0')}.000Z` });
    }

    const days = byDate(await runJournalExport(db, user));
    const log = days.get(day)!.day_log!;
    expect(log.scheduled[0]!.done).toBe(false);
    const completed = new Map(log.completed.map((c) => [c.title, c]));
    expect(completed.get('ad-hoc')!.planned).toBe(false);
    expect(completed.get('dead idea')!.disposition).toBe('obsolete');
    expect(log.truncated).toBeUndefined();

    const capped = days.get(flood)!.day_log!;
    expect(capped.completed).toHaveLength(100);
    expect(capped.truncated).toEqual({ scheduled: 0, completed: 1 });
  });

  it('is owner-scoped: another user\'s facts never leak into a log', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await utcSettings(mine);
    await utcSettings(theirs);
    await task(theirs, 'their secret', { completed_at: '2026-05-13T15:00:00.000Z' });
    expect(await runJournalExport(db, mine)).toEqual([]);
    const others = await runJournalExport(db, theirs);
    expect(others[0]!.day_log!.completed.map((c) => c.title)).toEqual(['their secret']);
  });

  it('the SEEDED log-only past-month day is exported (the V5 archive proof)', async () => {
    await seedDemoUser(url);
    const days = byDate(await runJournalExport(db, DEMO_USER_ID));
    // 2026-05-08 has a committed block + a completed task and NO journal note.
    const logOnly = days.get('2026-05-08');
    expect(logOnly).toBeDefined();
    expect(logOnly!.content).toBe('');
    expect(logOnly!.day_log!.scheduled).toHaveLength(1);
    expect(logOnly!.day_log!.completed[0]!.title).toBe('Write the April retro 📝');
    expect(logOnly!.day_log!.completed[0]!.planned).toBe(true);
    // the seeded NOTE days are still plain notes
    expect(days.get('2026-04-15')!.content).toContain('# Kickoff');
    expect(days.get('2026-04-15')!.day_log).toBeUndefined();
  });
});

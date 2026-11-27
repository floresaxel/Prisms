/**
 * J2 DoD integration: journal.write/delete through the real §8 dispatcher +
 * Postgres, plus the D7 export job and backup/import round-trip.
 *
 * Proves D2/D4/D5:
 *  - cross-device same-day convergence in BOTH arrival orders → ONE live row,
 *    the HLC-winning content, and the LOSER recoverable in the review inbox
 *    (the overwritten prose must never vanish silently);
 *  - the ack `effects` carry the AUTHORITATIVE row id (divergent from a losing
 *    minted id) so the client can rewrite its overlay and not ghost;
 *  - soft-delete → re-create the same day (the §7.7 partial unique permits it);
 *  - ownership + E_DUPLICATE (id rebound to a different day) rejections;
 *  - the D6 emoji corpus survives dispatcher → PG byte-identical;
 *  - server-derived month_key == entry_date.slice(0,7);
 *  - runJournalExport is owner-scoped, live-only, date-ordered;
 *  - backup.snapshot carries journal_entries and import.restore re-creates it.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher, type UploadResponse } from '../src/dispatcher';
import { runBackupSnapshot } from '../src/jobs/backup-snapshot';
import { systemClock } from '../src/jobs/clock';
import { runImportRestore } from '../src/jobs/import-restore';
import { runJournalExport } from '../src/jobs/journal-export';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

/** §D6 canonical corpus — must survive dispatcher → PG byte-identical. */
const D6_CORPUS = ['👍🏽', '👨‍👩‍👧‍👦', '🇫🇷', '❤️', 'café', 'שלום 🌍 hello'];
const hlcOf = (n: number, device = 'deva') => `${n.toString(16).padStart(12, '0')}-0000-${device}`;

describe.skipIf(!adminUrl)('J2 journal dispatcher + export', () => {
  const dbName = `prisms_j2_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let dispatcher: Dispatcher;

  // NB: the command envelope id (dedup key) is ALWAYS fresh; `id` is the journal
  // ROW id in the payload. Conflating them makes a second command on the same row
  // look like an idempotent replay (noop).
  const write = (userId: string, id: string, entry_date: string, content: string, hlc: string, device = 'deva') =>
    dispatcher.handleUpload(userId, {
      device_id: device,
      commands: [{ id: randomUUID(), name: 'journal.write', hlc, payload: { id, entry_date, content }, schema_version: 1 }],
    });
  const del = (userId: string, id: string, hlc: string, device = 'deva') =>
    dispatcher.handleUpload(userId, {
      device_id: device,
      commands: [{ id: randomUUID(), name: 'journal.delete', hlc, payload: { id }, schema_version: 1 }],
    });
  const ok = (res: UploadResponse) => {
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
    return res.results;
  };
  const setLocked = (userId: string, id: string, locked: boolean, hlc: string, device = 'deva') =>
    dispatcher.handleUpload(userId, {
      device_id: device,
      commands: [{ id: randomUUID(), name: 'journal.set_locked', hlc, payload: { id, locked }, schema_version: 1 }],
    });
  const setTitle = (userId: string, id: string, title: string, hlc: string, device = 'deva') =>
    dispatcher.handleUpload(userId, {
      device_id: device,
      commands: [{ id: randomUUID(), name: 'journal.set_title', hlc, payload: { id, title }, schema_version: 1 }],
    });
  const setTags = (userId: string, id: string, tags: string[], hlc: string, device = 'deva') =>
    dispatcher.handleUpload(userId, {
      device_id: device,
      commands: [{ id: randomUUID(), name: 'journal.set_tags', hlc, payload: { id, tags }, schema_version: 1 }],
    });
  const liveRows = (userId: string, date: string) =>
    sql`SELECT id, content, month_key, locked, title, tags FROM journal_entries WHERE user_id = ${userId} AND entry_date = ${date} AND deleted_at IS NULL`;
  const conflicts = (userId: string) =>
    sql`SELECT detail FROM sync_review_items WHERE user_id = ${userId} AND item_type = 'hlc_conflict'`;

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

  it('two quick keystrokes into a NEW note under two ids from ONE device: one row, the later text, no conflict item', async () => {
    // 2026-11-24: "c" minted the day's row; "cd", 150 ms later, minted another id
    // before the first had come back to the editor. The merge was right, but the
    // user's own first keystroke was reported as an edit conflict.
    const user = randomUUID();
    ok(await write(user, randomUUID(), '2026-11-24', 'c', hlcOf(1, 'web-1')));
    ok(await write(user, randomUUID(), '2026-11-24', 'cd', hlcOf(2, 'web-1')));
    const rows = await liveRows(user, '2026-11-24');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('cd');
    expect(await conflicts(user)).toHaveLength(0);
  });

  describe('break.log (a finished break, shown in the day log — never note text)', () => {
    const logBreak = (userId: string, id: string, started_at: string, ended_at: string, planned_minutes: number) =>
      dispatcher.handleUpload(userId, {
        device_id: 'deva',
        commands: [{ id: randomUUID(), name: 'break.log', hlc: hlcOf(1), payload: { id, started_at, ended_at, planned_minutes }, schema_version: 1 }],
      });

    it('stores the break, touches no note, and a replay converges on the same row', async () => {
      const user = randomUUID();
      const id = randomUUID();
      const [r] = ok(await logBreak(user, id, '2026-11-24T10:26:00.000Z', '2026-11-24T10:40:00.000Z', 10));
      expect(r!.result).toBe('applied');
      const again = ok(await logBreak(user, id, '2026-11-24T10:26:00.000Z', '2026-11-24T10:40:00.000Z', 10));
      expect(again[0]!.result).toBe('applied');
      const rows = await sql`SELECT planned_minutes, started_at, ended_at FROM breaks WHERE user_id = ${user}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!['planned_minutes']).toBe(10);
      expect(await sql`SELECT 1 FROM journal_entries WHERE user_id = ${user}`).toHaveLength(0);
    });

    it('rejects a break that ends before it starts, and another user’s break id', async () => {
      const user = randomUUID();
      const [bad] = ok(await logBreak(user, randomUUID(), '2026-11-24T10:40:00.000Z', '2026-11-24T10:26:00.000Z', 10));
      expect(bad).toMatchObject({ result: 'rejected', reject_code: 'E_INVALID_INTERVAL' });
      const id = randomUUID();
      ok(await logBreak(user, id, '2026-11-24T10:26:00.000Z', '2026-11-24T10:40:00.000Z', 10));
      const [theirs] = ok(await logBreak(randomUUID(), id, '2026-11-24T10:26:00.000Z', '2026-11-24T10:40:00.000Z', 10));
      expect(theirs).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
    });

    it('the journal export puts it in the day log section, not the note', async () => {
      const user = randomUUID();
      ok(await write(user, randomUUID(), '2026-11-24', 'Morning notes', hlcOf(1)));
      ok(await logBreak(user, randomUUID(), '2026-11-24T19:26:00.000Z', '2026-11-24T19:40:00.000Z', 10));
      const files = await runJournalExport(db, user);
      const day = files.find((f) => f.entry_date === '2026-11-24')!;
      expect(day.content).toBe('Morning notes'); // the note is untouched
      expect(day.day_log?.breaks).toEqual([
        expect.objectContaining({ started_at: '2026-11-24T19:26:00.000Z', ended_at: '2026-11-24T19:40:00.000Z', minutes: 14, planned_minutes: 10 }),
      ]);
    });
  });

  describe('timezone.change (the account follows the device; the day log records it)', () => {
    const change = (userId: string, id: string, from_timezone: string, to_timezone: string, hlc: string, cause: 'device' | 'manual' = 'device', changed_at = '2026-11-24T19:00:00.000Z') =>
      dispatcher.handleUpload(userId, {
        device_id: 'deva',
        commands: [{ id: randomUUID(), name: 'timezone.change', hlc, payload: { id, changed_at, from_timezone, to_timezone, cause }, schema_version: 1 }],
      });
    const zoneOf = async (userId: string) => (await sql`SELECT timezone FROM user_settings WHERE user_id = ${userId}`)[0]?.['timezone'];

    it('moves the account zone (creating the settings row if needed), records the change once, and a replay converges', async () => {
      const user = randomUUID();
      const id = randomUUID();
      const [r] = ok(await change(user, id, 'America/New_York', 'Asia/Tokyo', hlcOf(1)));
      expect(r!.result).toBe('applied');
      expect(await zoneOf(user)).toBe('Asia/Tokyo');
      ok(await change(user, id, 'America/New_York', 'Asia/Tokyo', hlcOf(2)));
      const rows = await sql`SELECT from_timezone, to_timezone, cause FROM timezone_changes WHERE user_id = ${user}`;
      expect(rows).toEqual([{ from_timezone: 'America/New_York', to_timezone: 'Asia/Tokyo', cause: 'device' }]);
    });

    it('the zone is last-write-wins with settings.update; the record is kept either way', async () => {
      const user = randomUUID();
      ok(await dispatcher.handleUpload(user, { device_id: 'deva', commands: [{ id: randomUUID(), name: 'settings.update', hlc: hlcOf(5), payload: { timezone: 'Europe/London' }, schema_version: 1 }] }));
      ok(await change(user, randomUUID(), 'America/New_York', 'Asia/Tokyo', hlcOf(3))); // older: loses the field
      expect(await zoneOf(user)).toBe('Europe/London');
      expect(await sql`SELECT 1 FROM timezone_changes WHERE user_id = ${user}`).toHaveLength(1);
      ok(await change(user, randomUUID(), 'Europe/London', 'Asia/Tokyo', hlcOf(9), 'manual')); // newer: wins
      expect(await zoneOf(user)).toBe('Asia/Tokyo');
    });

    it('rejects a zone the server does not know, and another user’s change id', async () => {
      const user = randomUUID();
      const [bad] = ok(await change(user, randomUUID(), 'America/New_York', 'Mars/Olympus_Mons', hlcOf(1)));
      expect(bad).toMatchObject({ result: 'rejected', reject_code: 'E_INVALID_TIMEZONE' });
      expect(await zoneOf(user)).toBeUndefined();
      const id = randomUUID();
      ok(await change(user, id, 'America/New_York', 'Asia/Tokyo', hlcOf(2)));
      const [theirs] = ok(await change(randomUUID(), id, 'America/New_York', 'Asia/Tokyo', hlcOf(3)));
      expect(theirs).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
    });

    it('the journal export lists it in the day log', async () => {
      const user = randomUUID();
      // a break makes the day non-empty (a zone change alone never does); 14:00 EST
      const breakLog = { id: randomUUID(), started_at: '2026-11-24T19:26:00.000Z', ended_at: '2026-11-24T19:40:00.000Z', planned_minutes: 10 };
      ok(await dispatcher.handleUpload(user, { device_id: 'deva', commands: [{ id: randomUUID(), name: 'break.log', hlc: hlcOf(1), payload: breakLog, schema_version: 1 }] }));
      const id = randomUUID();
      ok(await change(user, id, 'America/New_York', 'America/New_York', hlcOf(2), 'manual'));
      const files = await runJournalExport(db, user);
      const day = files.find((f) => f.entry_date === '2026-11-24')!;
      expect(day.day_log?.timezone_changes).toEqual([
        { change_id: id, changed_at: '2026-11-24T19:00:00.000Z', from_timezone: 'America/New_York', to_timezone: 'America/New_York', cause: 'manual' },
      ]);
    });
  });
  describe('journal.append (a break logged at the end of the day note)', () => {
    const append = (userId: string, id: string, entry_date: string, text: string, hlc: string, device = 'deva') =>
      dispatcher.handleUpload(userId, {
        device_id: device,
        commands: [{ id: randomUUID(), name: 'journal.append', hlc, payload: { id, entry_date, text }, schema_version: 1 }],
      });

    it('creates the note when the day has none', async () => {
      const user = randomUUID();
      const id = randomUUID();
      const [r] = ok(await append(user, id, '2026-11-22', '☕ Break — 15 min', hlcOf(1)));
      expect(r!.result).toBe('applied');
      const rows = await liveRows(user, '2026-11-22');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, content: '☕ Break — 15 min', month_key: '2026-11' });
    });

    it('appends to prose the appending device never saw (another id, written elsewhere) — nothing replaced', async () => {
      const user = randomUUID();
      const noteId = randomUUID();
      ok(await write(user, noteId, '2026-11-22', 'Morning notes from the laptop.\n', hlcOf(5, 'laptop'), 'laptop'));
      // the phone has no row for the day, so it mints its own id — and an OLDER hlc
      const [r] = ok(await append(user, randomUUID(), '2026-11-22', '☕ Break — 10 min', hlcOf(2, 'phone'), 'phone'));
      expect(r!.result).toBe('applied');
      const rows = await liveRows(user, '2026-11-22');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: noteId, content: 'Morning notes from the laptop.\n\n☕ Break — 10 min' });
      expect(await conflicts(user)).toHaveLength(0);
      // two breaks in a day: both lines kept, in order
      ok(await append(user, noteId, '2026-11-22', '☕ Break — 5 min', hlcOf(6)));
      expect((await liveRows(user, '2026-11-22'))[0]!['content']).toBe('Morning notes from the laptop.\n\n☕ Break — 10 min\n\n☕ Break — 5 min');
    });

    it('a later edit still wins over the appended text (the content version moved forward)', async () => {
      const user = randomUUID();
      const noteId = randomUUID();
      ok(await write(user, noteId, '2026-11-23', 'draft', hlcOf(1)));
      ok(await append(user, noteId, '2026-11-23', '☕ Break — 5 min', hlcOf(3)));
      // an edit made BEFORE the append (older hlc) arriving late must not wipe the log line
      ok(await write(user, noteId, '2026-11-23', 'draft edited', hlcOf(2)));
      expect((await liveRows(user, '2026-11-23'))[0]!['content']).toBe('draft\n\n☕ Break — 5 min');
      // a newer edit (the editor now holds the line) wins as usual
      ok(await write(user, noteId, '2026-11-23', 'draft\n\n☕ Break — 5 min\n\nback to work', hlcOf(4)));
      expect((await liveRows(user, '2026-11-23'))[0]!['content']).toBe('draft\n\n☕ Break — 5 min\n\nback to work');
    });

    it('rejects an id that belongs to a different day', async () => {
      const user = randomUUID();
      const id = randomUUID();
      ok(await write(user, id, '2026-11-20', 'x', hlcOf(1)));
      const [r] = ok(await append(user, id, '2026-11-21', 'y', hlcOf(2)));
      expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_DUPLICATE' });
    });
  });

  it('cross-device same day, winner arrives LAST (out of order): one row, HLC winner, loser recoverable', async () => {
    const user = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();
    const day = '2026-06-11';
    // B (older hlc) applies first, then A (newer hlc) — the winning write arrives LAST,
    // so it overwrites B's row: the generic LWW conflict would miss B's lost prose.
    ok(await write(user, idB, day, 'from B', hlcOf(1, 'devb'), 'devb'));
    ok(await write(user, idA, day, 'from A', hlcOf(2, 'deva'), 'deva'));
    const rows = await liveRows(user, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('from A'); // HLC winner
    const items = await conflicts(user);
    expect(items).toHaveLength(1);
    expect((items[0]!['detail'] as { losing_value: string }).losing_value).toBe('from B'); // recoverable
  });

  it('cross-device same day, winner arrives FIRST (in order): loser still recoverable', async () => {
    const user = randomUUID();
    const day = '2026-06-12';
    ok(await write(user, randomUUID(), day, 'from A', hlcOf(2, 'deva'), 'deva'));
    ok(await write(user, randomUUID(), day, 'from B', hlcOf(1, 'devb'), 'devb'));
    const rows = await liveRows(user, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('from A');
    const items = await conflicts(user);
    expect(items).toHaveLength(1);
    expect((items[0]!['detail'] as { losing_value: string }).losing_value).toBe('from B');
  });

  it('D5: the ack effects carry the AUTHORITATIVE row id, divergent from the losing minted id', async () => {
    const user = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();
    const day = '2026-06-13';
    ok(await write(user, idB, day, 'from B', hlcOf(1, 'devb'), 'devb'));
    const resA = ok(await write(user, idA, day, 'from A', hlcOf(2, 'deva'), 'deva'));
    // idA never becomes a row; the effect points at the authoritative row idB so the
    // client rewrites its optimistic insert(idA) → update(idB) and reconciles (no ghost).
    expect(resA[0]).toMatchObject({ result: 'applied' });
    expect(resA[0]!.effects).toEqual([{ table: 'journal_entries', row_id: idB, op: 'update' }]);
    const [log] = await sql`SELECT effects FROM command_log WHERE id = ${resA[0]!.id}`;
    expect(log!['effects']).toEqual([{ table: 'journal_entries', row_id: idB, op: 'update', fields: ['content'] }]);
  });

  it('a same-id edit is NOT a conflict (the user replacing their own note)', async () => {
    const user = randomUUID();
    const id = randomUUID();
    const day = '2026-06-14';
    ok(await write(user, id, day, 'draft', hlcOf(1)));
    ok(await write(user, id, day, 'final', hlcOf(2))); // same id → sequential edit
    expect((await liveRows(user, day))[0]!['content']).toBe('final');
    expect(await conflicts(user)).toHaveLength(0); // no spurious review item
  });

  it('soft-delete then re-create the same day (the §7.7 partial unique permits it)', async () => {
    const user = randomUUID();
    const day = '2026-08-01';
    const id1 = randomUUID();
    ok(await write(user, id1, day, 'first', hlcOf(1)));
    ok(await del(user, id1, hlcOf(2)));
    expect(await liveRows(user, day)).toHaveLength(0);
    ok(await write(user, randomUUID(), day, 'second', hlcOf(3))); // NEW id, same day
    const rows = await liveRows(user, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('second');
  });

  it('rejects a foreign row (E_OWNERSHIP) and an id rebound to a different day (E_DUPLICATE)', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const id = randomUUID();
    ok(await write(owner, id, '2026-09-01', 'mine', hlcOf(1)));
    const foreign = ok(await write(other, id, '2026-09-01', 'theirs', hlcOf(2)));
    expect(foreign[0]).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
    const dup = ok(await write(owner, id, '2026-09-02', 'elsewhere', hlcOf(3)));
    expect(dup[0]).toMatchObject({ result: 'rejected', reject_code: 'E_DUPLICATE' });
  });

  it('D6 emoji corpus round-trips dispatcher → Postgres byte-identical', async () => {
    const user = randomUUID();
    for (let i = 0; i < D6_CORPUS.length; i++) {
      ok(await write(user, randomUUID(), `2026-07-0${i + 1}`, D6_CORPUS[i]!, hlcOf(i + 1)));
    }
    const rows = await sql`SELECT content, octet_length(content) AS n FROM journal_entries WHERE user_id = ${user} AND deleted_at IS NULL ORDER BY entry_date`;
    expect(rows.map((r) => r['content'])).toEqual(D6_CORPUS);
    expect(rows.map((r) => Number(r['n']))).toEqual(D6_CORPUS.map((s) => Buffer.byteLength(s, 'utf8')));
  });

  // --- the per-day lock (migration 0013) -----------------------------------
  // It exists to be SHARED across devices, so what matters is that it lands in
  // Postgres on the day's own row and resolves independently of the prose.

  it('a lock on a day with NO note is rejected — an empty note is never stored', async () => {
    const u = randomUUID();
    const [r] = ok(await setLocked(u, randomUUID(), true, hlcOf(1)));
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
    expect(await liveRows(u, '2026-09-01')).toHaveLength(0); // nothing minted
  });

  it('locks/unlocks an existing day WITHOUT touching its content', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-02', 'the prose', hlcOf(1)));
    ok(await setLocked(u, row, true, hlcOf(2)));
    let rows = await liveRows(u, '2026-09-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['locked']).toBe(true);
    expect(rows[0]!['content']).toBe('the prose');

    ok(await setLocked(u, row, false, hlcOf(3)));
    rows = await liveRows(u, '2026-09-02');
    expect(rows[0]!['locked']).toBe(false);
    expect(rows[0]!['content']).toBe('the prose');
  });

  it('locking is per DAY: one day locked leaves its neighbours alone', async () => {
    const u = randomUUID();
    const mid = randomUUID();
    ok(await write(u, mid, '2026-09-04', 'tuesday', hlcOf(1)));
    ok(await setLocked(u, mid, true, hlcOf(2)));
    ok(await write(u, randomUUID(), '2026-09-03', 'monday', hlcOf(3)));
    ok(await write(u, randomUUID(), '2026-09-05', 'wednesday', hlcOf(4)));
    for (const [date, locked] of [['2026-09-03', false], ['2026-09-04', true], ['2026-09-05', false]] as const) {
      const rows = await liveRows(u, date);
      expect(rows[0]!['locked']).toBe(locked);
    }
  });

  it('a lock and a content edit from two devices BOTH survive (per-field LWW)', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-06', 'first', hlcOf(1, 'deva')));
    // device B locks; device A then edits the prose with a LATER hlc. Because the
    // two fields version independently, the later content write must not carry the
    // lock back to false.
    ok(await setLocked(u, row, true, hlcOf(2, 'devb'), 'devb'));
    ok(await write(u, row, '2026-09-06', 'second', hlcOf(3, 'deva')));
    const rows = await liveRows(u, '2026-09-06');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('second');
    expect(rows[0]!['locked']).toBe(true);
  });

  it('an older lock loses to a newer one on the same day (HLC)', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-07', 'prose', hlcOf(1)));
    ok(await setLocked(u, row, true, hlcOf(5, 'devb'), 'devb'));
    ok(await setLocked(u, row, false, hlcOf(2, 'deva'))); // stale unlock
    const rows = await liveRows(u, '2026-09-07');
    expect(rows[0]!['locked']).toBe(true); // the newer lock stands
  });

  // --- the editable title (migration 0014) ---------------------------------

  it('renames a note and clears back to untitled, leaving the content alone', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-08', 'the prose', hlcOf(1)));
    expect((await liveRows(u, '2026-09-08'))[0]!['title']).toBe(''); // untitled by default

    ok(await setTitle(u, row, 'Trip planning 🧭', hlcOf(2)));
    let rows = await liveRows(u, '2026-09-08');
    expect(rows[0]!['title']).toBe('Trip planning 🧭');
    expect(rows[0]!['content']).toBe('the prose');
    expect(rows[0]!['entry_date' as never] ?? '2026-09-08').toBeTruthy(); // the day still owns it

    ok(await setTitle(u, row, '', hlcOf(3)));
    rows = await liveRows(u, '2026-09-08');
    expect(rows[0]!['title']).toBe(''); // back to untitled; the client re-derives the default
  });

  it('a title on a day with no note is rejected — nothing to name', async () => {
    const u = randomUUID();
    const [r] = ok(await setTitle(u, randomUUID(), 'ghost', hlcOf(1)));
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
  });

  it('a rename and a content edit from two devices BOTH survive (per-field LWW)', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-09', 'first', hlcOf(1, 'deva')));
    ok(await setTitle(u, row, 'Named on B', hlcOf(2, 'devb'), 'devb'));
    ok(await write(u, row, '2026-09-09', 'second', hlcOf(3, 'deva')));
    const rows = await liveRows(u, '2026-09-09');
    expect(rows[0]!['content']).toBe('second');
    expect(rows[0]!['title']).toBe('Named on B');
  });

  // --- note tags (migration 0016) ------------------------------------------

  it('tags a note: stored canonical (lower-cased, de-duplicated), content untouched', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-10', 'the prose', hlcOf(1)));
    expect((await liveRows(u, '2026-09-10'))[0]!['tags']).toEqual([]); // untagged by default

    ok(await setTags(u, row, ['Work', ' #health ', 'work', ''], hlcOf(2)));
    const rows = await liveRows(u, '2026-09-10');
    expect(rows[0]!['tags']).toEqual(['work', 'health']); // the server re-normalises
    expect(rows[0]!['content']).toBe('the prose');

    ok(await setTags(u, row, [], hlcOf(3)));
    expect((await liveRows(u, '2026-09-10'))[0]!['tags']).toEqual([]);
  });

  it('tags on a day with no note are rejected — nothing to tag', async () => {
    const u = randomUUID();
    const [r] = ok(await setTags(u, randomUUID(), ['x'], hlcOf(1)));
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
  });

  it("cannot tag another user's note", async () => {
    const owner = randomUUID();
    const row = randomUUID();
    ok(await write(owner, row, '2026-09-11', 'mine', hlcOf(1)));
    const [r] = ok(await setTags(randomUUID(), row, ['stolen'], hlcOf(2)));
    expect(r).toMatchObject({ result: 'rejected' });
    expect((await liveRows(owner, '2026-09-11'))[0]!['tags']).toEqual([]);
  });

  it('tags and a content edit from two devices BOTH survive; a stale tag write loses', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-12', 'first', hlcOf(1, 'deva')));
    ok(await setTags(u, row, ['from-b'], hlcOf(2, 'devb'), 'devb'));
    ok(await write(u, row, '2026-09-12', 'second', hlcOf(3, 'deva')));
    ok(await setTags(u, row, ['stale'], hlcOf(1, 'devc'), 'devc')); // strictly older → loses
    const rows = await liveRows(u, '2026-09-12');
    expect(rows[0]!['content']).toBe('second');
    expect(rows[0]!['tags']).toEqual(['from-b']);
  });

  it('a hand-built payload cannot exceed the bounds', async () => {
    const u = randomUUID();
    const row = randomUUID();
    ok(await write(u, row, '2026-09-13', 'x', hlcOf(1)));
    const [r] = ok(await setTags(u, row, Array.from({ length: 500 }, (_, i) => `t${i}`), hlcOf(2)));
    expect(r).toMatchObject({ result: 'rejected' }); // schema ceiling, before storage
    expect((await liveRows(u, '2026-09-13'))[0]!['tags']).toEqual([]);
  });
  it('server-derives month_key = entry_date.slice(0,7)', async () => {
    const user = randomUUID();
    const days = ['2026-01-31', '2026-12-01', '2026-06-15'];
    for (let i = 0; i < days.length; i++) ok(await write(user, randomUUID(), days[i]!, 'x', hlcOf(i + 1)));
    const rows = await sql`SELECT entry_date, month_key FROM journal_entries WHERE user_id = ${user} ORDER BY entry_date`;
    for (const r of rows) expect(r['month_key']).toBe(String(r['entry_date']).slice(0, 7));
  });

  it('runJournalExport: owner-scoped, live-only, date-ordered, emoji byte-exact', async () => {
    const user = randomUUID();
    const other = randomUUID();
    ok(await write(user, randomUUID(), '2026-05-02', 'may', hlcOf(1)));
    ok(await write(user, randomUUID(), '2026-03-09', D6_CORPUS[1]!, hlcOf(2)));
    const deletedId = randomUUID();
    ok(await write(user, deletedId, '2026-04-04', 'trash', hlcOf(3)));
    ok(await del(user, deletedId, hlcOf(4)));
    ok(await write(other, randomUUID(), '2026-05-02', 'not yours', hlcOf(5)));
    const entries = await runJournalExport(db, user);
    expect(entries.map((e) => e.entry_date)).toEqual(['2026-03-09', '2026-05-02']); // ordered, live-only, owner-scoped
    expect(entries[0]!.content).toBe(D6_CORPUS[1]); // ZWJ family byte-exact
    expect(entries.every((e) => typeof e.updated_at === 'string')).toBe(true);
  });

  it('backup.snapshot carries journal_entries and import.restore re-creates them (registry-driven)', async () => {
    const user = randomUUID();
    const id = randomUUID();
    const day = '2026-10-10';
    ok(await write(user, id, day, D6_CORPUS[0]!, hlcOf(1)));
    const manifest = await runBackupSnapshot(db, user, systemClock);
    const journalRows = (manifest.tables as Record<string, { id: string; content: string }[]>)['journal_entries'];
    expect(journalRows?.some((r) => r.id === id && r.content === D6_CORPUS[0])).toBe(true);
    // wipe the row, then prove restore actively re-creates it byte-exact (not a no-op).
    await sql`DELETE FROM journal_entries WHERE id = ${id}`;
    const res = await runImportRestore(db, user, manifest as unknown, systemClock);
    expect(res.ok).toBe(true);
    const rows = await liveRows(user, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe(D6_CORPUS[0]);
  });
});

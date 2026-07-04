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
  const liveRows = (userId: string, date: string) =>
    sql`SELECT id, content, month_key FROM journal_entries WHERE user_id = ${userId} AND entry_date = ${date} AND deleted_at IS NULL`;
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

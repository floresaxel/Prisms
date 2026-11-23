/**
 * Clocking out while sync-down is stalled, on a REAL SQLite store (better-sqlite3)
 * so the actual `createSqlOverlayStore` SQL runs.
 *
 * The incident (2026-11-21): the computer's clock was changed while a timer ran.
 * The clock-out reached the server and was applied, but sync-down had stalled
 * (the clock change expired the sync token), so this device's replica still had
 * the entry OPEN. `time_entries` did not declare `last_modified_by_command_id`,
 * so reconcile confirmed the clock-out on row PRESENCE (an open entry is always
 * present), dropped its overlay, and the timer showed as running again. Every
 * retry was then refused by the server as E_TIMER_NOT_RUNNING.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clientSchema, createCommands, createSqlOverlayStore, readMergedRows, type OverlayStore, type SqlExecutor } from '../src/index';

const ENTRY = '01a1fce5-16f8-7c92-a1da-936d06553d14';
const TASK = '01a1f834-7ace-70fd-b249-b7c223925967';
const CLOCK_IN = '01a1fce5-16f8-7000-8000-000000000001';
// command ids minted by this device after the clock-in (UUIDv7: they sort later)
const CLOCK_OUT = '01a1fd00-0000-7000-8000-000000000002';
const REVIEW = '01a1fd00-0000-7000-8000-000000000003';

let db: Database.Database;
let store: OverlayStore;

beforeEach(() => {
  db = new Database(':memory:');
  // The replica's time_entries has exactly the columns the CLIENT SCHEMA declares
  // (PowerSync builds its view from it) — a column it leaves out is invisible to
  // `SELECT *` even though the server streams it.
  const replicaCols = clientSchema.tables.find((t) => t.name === 'time_entries')!.columns.map((c) => `${c.name} TEXT`);
  db.exec(`
    CREATE TABLE client_commands (id TEXT PRIMARY KEY, name TEXT, hlc TEXT, payload TEXT, status TEXT, created_at TEXT, command_version INTEGER, schema_version INTEGER, client_version TEXT, depends_on TEXT, reject_code TEXT, reject_reason TEXT);
    CREATE TABLE overlay_effects (id TEXT PRIMARY KEY, command_id TEXT, hlc TEXT, table_name TEXT, row_id TEXT, op TEXT, fields TEXT, seq INTEGER, created_at TEXT);
    CREATE TABLE time_entries (id TEXT PRIMARY KEY, ${replicaCols.join(', ')}, server_stamp TEXT);
  `);
  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    db.prepare(sql).run(...(params as never[]));
  };
  const all = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => db.prepare(sql).all(...(params as never[])) as T[];
  const tx = { execute: run, getAll: all };
  const exec: SqlExecutor = { execute: run, getAll: all, writeTransaction: async (fn) => fn(tx) };
  store = createSqlOverlayStore(exec);
});
afterEach(() => db.close());

/**
 * The entry as the server has it, stamped by the command that wrote it last. The
 * stamp only reaches the replica's view if the client schema declares the column.
 */
const setCanonical = (endedAt: string | null, stamp: string) => {
  const declared = clientSchema.tables.find((t) => t.name === 'time_entries')!.columns.some((c) => c.name === 'last_modified_by_command_id');
  db.prepare(`INSERT OR REPLACE INTO time_entries (id, user_id, task_id, started_at, ended_at, planned, device_id, ${declared ? 'last_modified_by_command_id' : 'server_stamp'}, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`)
    .run(ENTRY, 'u1', TASK, '2026-11-21T06:57:14.488Z', endedAt, 1, 'web-1', stamp, 't', 't');
};

const shownEnd = async () => (await readMergedRows(store, 'time_entries')).find((r) => r['id'] === ENTRY)?.['ended_at'] ?? null;

function commandsAt(nowIso: string, ids: string[]) {
  let i = 0;
  return createCommands(store, { userId: 'u1', deviceId: 'web-1', now: () => nowIso }, { mintId: () => ids[i++]!, nextHlc: () => `hlc-${i}`, now: () => nowIso });
}

describe('clocking out while sync-down is stalled', () => {
  it('the client schema declares the stamp on time_entries — or reconcile falls back to presence', () => {
    const table = clientSchema.tables.find((t) => t.name === 'time_entries')!;
    expect(table.columns.map((c) => c.name)).toContain('last_modified_by_command_id');
  });

  it('the timer stays stopped after the ack, for as long as the closed row has not synced down', async () => {
    setCanonical(null, CLOCK_IN); // the open entry has synced to this device
    await commandsAt('2026-11-21T10:53:39.603Z', [CLOCK_OUT]).clockOut(ENTRY);
    expect(await shownEnd()).toBe('2026-11-21T10:53:39.603Z');

    // the server applies it — but sync-down is stalled, so the replica is still open
    await store.markApplied(CLOCK_OUT, []);
    for (let i = 0; i < 3; i += 1) {
      expect((await store.reconcileConfirmed()).cleared).not.toContain(CLOCK_OUT);
      expect(await shownEnd()).toBe('2026-11-21T10:53:39.603Z'); // NOT running again
    }

    // sync resumes: the closed row arrives, stamped by the clock-out → confirmed
    setCanonical('2026-11-21T10:53:39.603Z', CLOCK_OUT);
    expect((await store.reconcileConfirmed()).cleared).toContain(CLOCK_OUT);
    expect(await shownEnd()).toBe('2026-11-21T10:53:39.603Z');
    expect(await store.effectsFor('time_entries')).toHaveLength(0);
  });

  it('a later write to the row (the session review) also confirms the clock-out — nothing strands', async () => {
    setCanonical(null, CLOCK_IN);
    await commandsAt('2026-11-21T10:53:39.603Z', [CLOCK_OUT]).clockOut(ENTRY);
    await store.markApplied(CLOCK_OUT, []);
    setCanonical('2026-11-21T10:53:39.603Z', REVIEW); // the row arrives already carrying the review
    expect((await store.reconcileConfirmed()).cleared).toContain(CLOCK_OUT);
    expect(await shownEnd()).toBe('2026-11-21T10:53:39.603Z');
  });

  it('a clock set back before the start still stops the timer (end floored at start + 1 s)', async () => {
    setCanonical(null, CLOCK_IN);
    // the computer now reads two hours before the entry started
    await commandsAt('2026-11-21T04:57:14.488Z', [CLOCK_OUT]).clockOut(ENTRY);
    const [pending] = await store.pendingCommands();
    expect(pending!.payload).toMatchObject({ entry_id: ENTRY, ended_at: '2026-11-21T06:57:15.488Z' });
    expect(await shownEnd()).toBe('2026-11-21T06:57:15.488Z');
  });
});

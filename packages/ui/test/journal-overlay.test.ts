/**
 * J3 — the journal overlay paths on a REAL SQLite store (better-sqlite3), so the
 * actual `createSqlOverlayStore` SQL runs:
 *   - D5 ack-rewrite convergence: two devices mint different ids for the SAME new
 *     day; the server converges onto one and the ack's authoritative row id
 *     diverges from the client's minted id. `markApplied(effects)` rewrites the
 *     overlay so the merged read shows EXACTLY ONE row for the date — before AND
 *     after the canonical row arrives — instead of ghosting on a phantom id;
 *   - offline-write → reconnect: the note stays visible throughout (overlay
 *     persists until the canonical row lands, then reconcile drops it — S7-F6).
 *
 * The D5 and offline cases below write canonical rows with NO stamp (a legacy
 * row), so reconcile confirms them on row PRESENCE — which is why the loser's
 * overlay clears once the winning canonical row (its rewritten id) arrives. The
 * client schema now declares `last_modified_by_command_id` for journal_entries,
 * and the last block proves what that buys: an edit of a note that has ALREADY
 * synced waits for the row stamped by it, instead of clearing on presence.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clientSchema, createSqlOverlayStore, readMergedRows, type OverlayStore, type SqlExecutor } from '../src/index';
import type { ClientCommand, OverlayEffect } from '@prisms/core';

let db: Database.Database;
let store: OverlayStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE client_commands (id TEXT PRIMARY KEY, name TEXT, hlc TEXT, payload TEXT, status TEXT, created_at TEXT, command_version INTEGER, schema_version INTEGER, client_version TEXT, depends_on TEXT);
    CREATE TABLE overlay_effects (id TEXT PRIMARY KEY, command_id TEXT, hlc TEXT, table_name TEXT, row_id TEXT, op TEXT, fields TEXT, seq INTEGER, created_at TEXT);
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, user_id TEXT, entry_date TEXT, month_key TEXT, content TEXT, locked INTEGER, title TEXT, last_modified_by_command_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
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

const DAY = '2026-06-11';
const cmd = (id: string, hlc: string): ClientCommand => ({ id, name: 'journal.write', hlc, payload: { id, entry_date: DAY, content: '' }, status: 'pending', created_at: '2026-06-27T00:00:00.000Z' });
const insEffect = (commandId: string, hlc: string, rowId: string, content: string): OverlayEffect => ({
  command_id: commandId, hlc, table: 'journal_entries', row_id: rowId, op: 'insert', seq: 0,
  fields: { id: rowId, user_id: 'u1', source_kind: 'user', entry_date: DAY, month_key: '2026-06', content, created_at: '2026-06-27T00:00:00.000Z', updated_at: '2026-06-27T00:00:00.000Z' },
});
const setCanonical = (id: string, content: string) =>
  db.prepare('INSERT INTO journal_entries (id, user_id, entry_date, month_key, content, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(id, 'u1', DAY, '2026-06', content, 't', 't');
const dayRows = async () => (await readMergedRows(store, 'journal_entries')).filter((r) => r['entry_date'] === DAY);

describe('write then delete before the canonical row has synced down', () => {
  const delEffect = (commandId: string, hlc: string, rowId: string): OverlayEffect => ({
    command_id: commandId, hlc, table: 'journal_entries', row_id: rowId, op: 'delete', seq: 0, fields: {},
  });

  it('does NOT resurrect the note once the delete is confirmed', async () => {
    // Type a note: an optimistic insert the server accepts…
    await store.enqueue(cmd('cmdWrite', 'hlc1'), [insEffect('cmdWrite', 'hlc1', 'row1', 'temporary thought')]);
    await store.markApplied('cmdWrite');
    expect(await dayRows()).toHaveLength(1);

    // …then clear it, which deletes the row — BEFORE the canonical row ever
    // arrived. Its insert effect can therefore never be confirmed the normal way:
    // the row it waits for is gone server-side and will never sync down.
    await store.enqueue({ ...cmd('cmdDelete', 'hlc2'), name: 'journal.delete' }, [delEffect('cmdDelete', 'hlc2', 'row1')]);
    await store.markApplied('cmdDelete');
    expect(await dayRows()).toHaveLength(0); // the pending delete hides it

    // The delete confirms (the row is absent from the replica). The stale insert
    // must go with it — otherwise the merged read brings the note back.
    const { cleared } = await store.reconcileConfirmed();
    expect(cleared).toContain('cmdDelete');
    expect(await dayRows()).toHaveLength(0);
    expect(await store.effectsFor('journal_entries')).toHaveLength(0);
  });

  it('still waits for a plain insert whose row simply has not downloaded yet', async () => {
    // The guard above must not degrade into "clear on absence" — that would
    // reintroduce the ack→download revert flicker (S7-F6).
    await store.enqueue(cmd('cmdWrite', 'hlc1'), [insEffect('cmdWrite', 'hlc1', 'row1', 'still in flight')]);
    await store.markApplied('cmdWrite');
    expect(await store.reconcileConfirmed()).toEqual({ cleared: [] });
    expect(await dayRows()).toHaveLength(1); // overlay held; no flicker
  });
});

describe('D5 ack-rewrite convergence (divergent authoritative row id)', () => {
  it('rewrites the overlay to the server id → exactly one row before AND after canonical arrival', async () => {
    // Device A optimistically creates the day as idA (its overlay insert).
    await store.enqueue(cmd('cmdA', 'hlcA'), [insEffect('cmdA', 'hlcA', 'idA', 'from A')]);
    let rows = await dayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'idA', content: 'from A' });

    // The server converged onto a DIFFERENT row (idB) — the ack effect diverges.
    await store.markApplied('cmdA', [{ table: 'journal_entries', row_id: 'idB', op: 'update' }]);

    // The overlay effect was rewritten (row_id + fields.id → idB, op → update).
    const [eff] = await store.effectsFor('journal_entries');
    expect(eff).toMatchObject({ row_id: 'idB', op: 'update' });
    expect((eff!.fields as { id: string }).id).toBe('idB');

    // Before the canonical row arrives: exactly ONE row, now keyed idB (no phantom idA).
    rows = await dayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'idB', content: 'from A' });

    // Canonical idB (the winning content) syncs down → reconcile clears the overlay.
    setCanonical('idB', 'from A');
    expect((await store.reconcileConfirmed()).cleared).toEqual(['cmdA']);
    rows = await dayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'idB', content: 'from A' });
    expect(await store.effectsFor('journal_entries')).toHaveLength(0);
  });
});

describe('offline-write → reconnect (S7-F6: note visible throughout)', () => {
  it('keeps the overlay after the applied ack until the canonical row lands', async () => {
    await store.enqueue(cmd('cmdX', 'hlcX'), [insEffect('cmdX', 'hlcX', 'idX', 'offline note')]);
    expect(await dayRows()).toMatchObject([{ id: 'idX', content: 'offline note' }]); // offline: visible

    // Reconnect: server applies it on the SAME row (non-divergent ack). Overlay KEPT.
    await store.markApplied('cmdX', [{ table: 'journal_entries', row_id: 'idX', op: 'insert' }]);
    expect(await store.pendingCommands()).toHaveLength(0); // not re-uploadable
    expect(await dayRows()).toMatchObject([{ id: 'idX', content: 'offline note' }]); // STILL visible — no flicker

    // Canonical arrives → reconcile drops the overlay; the note stays visible (now canonical).
    setCanonical('idX', 'offline note');
    expect((await store.reconcileConfirmed()).cleared).toEqual(['cmdX']);
    expect(await store.effectsFor('journal_entries')).toHaveLength(0);
    expect(await dayRows()).toMatchObject([{ id: 'idX', content: 'offline note' }]);
  });
});

describe('locking a note that has already synced (stamped rows)', () => {
  // The command ids from the CI run that caught this (PR #27): UUIDv7, so they
  // sort by mint time — the write came first, the lock after it.
  const WRITE = '01a1e68f-5f64-7ac6-99ef-99340274c6c6';
  const LOCK = '01a1e68f-605a-7c01-89e9-13730b4aef60';
  const UNLOCK = '01a1e68f-6a10-7d22-8f00-0123456789ab';
  const ROW = '01a1e68f-5f62-70bd-af9c-29b1c8015dfd';

  /** The note as the server has it, stamped by the command that wrote it last. */
  const setStamped = (locked: 0 | 1, stamp: string) =>
    db
      .prepare('INSERT OR REPLACE INTO journal_entries (id, user_id, entry_date, month_key, content, locked, title, last_modified_by_command_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)')
      .run(ROW, 'u1', DAY, '2026-06', 'Standup notes', locked, '', stamp, 't', 't');
  const lockCmd = (id: string, hlc: string, locked: boolean): ClientCommand => ({
    id, name: 'journal.set_locked', hlc, payload: { id: ROW, locked }, status: 'pending', created_at: '2026-06-27T00:00:00.000Z',
  });
  const lockEffect = (commandId: string, hlc: string, locked: 0 | 1): OverlayEffect => ({
    command_id: commandId, hlc, table: 'journal_entries', row_id: ROW, op: 'update', seq: 0, fields: { locked },
  });
  const shownLocked = async () => (await dayRows())[0]?.['locked'];

  it('the client schema declares the stamp — or reconcile cannot see it and falls back to presence', () => {
    const table = clientSchema.tables.find((t) => t.name === 'journal_entries')!;
    expect(table.columns.map((c) => c.name)).toContain('last_modified_by_command_id');
  });

  it('stays locked between the ack and the locked row syncing down — no flick back to editable', async () => {
    setStamped(0, WRITE); // the note exists and has synced: its row carries the write's stamp
    await store.enqueue(lockCmd(LOCK, 'hlc2', true), [lockEffect(LOCK, 'hlc2', 1)]);
    await store.markApplied(LOCK, [{ table: 'journal_entries', row_id: ROW, op: 'update' }]);

    // Acked, but the row on this device is still the WRITE's. Presence alone used
    // to confirm the lock right here, and the note read unlocked again.
    expect((await store.reconcileConfirmed()).cleared).not.toContain(LOCK);
    expect(await shownLocked()).toBe(1);

    // the locked row arrives, stamped by the lock → now it is confirmed
    setStamped(1, LOCK);
    expect((await store.reconcileConfirmed()).cleared).toContain(LOCK);
    expect(await shownLocked()).toBe(1);
    expect(await store.effectsFor('journal_entries')).toHaveLength(0);
  });

  it('a lock then an unlock settle on unlocked, whichever stamp is on the row in between', async () => {
    setStamped(0, WRITE);
    await store.enqueue(lockCmd(LOCK, 'hlc2', true), [lockEffect(LOCK, 'hlc2', 1)]);
    await store.enqueue(lockCmd(UNLOCK, 'hlc3', false), [lockEffect(UNLOCK, 'hlc3', 0)]);
    await store.markApplied(LOCK, [{ table: 'journal_entries', row_id: ROW, op: 'update' }]);
    await store.markApplied(UNLOCK, [{ table: 'journal_entries', row_id: ROW, op: 'update' }]);

    // only the LOCKED row has synced so far: the lock is confirmed, the unlock is not
    setStamped(1, LOCK);
    const first = await store.reconcileConfirmed();
    expect(first.cleared).toContain(LOCK);
    expect(first.cleared).not.toContain(UNLOCK);
    expect(await shownLocked()).toBe(0); // the pending unlock still wins on screen

    // the unlocked row arrives
    setStamped(0, UNLOCK);
    expect((await store.reconcileConfirmed()).cleared).toContain(UNLOCK);
    expect(await shownLocked()).toBe(0);
  });

  it('a row stamped by a LATER command (another device) confirms the earlier one — nothing strands', async () => {
    setStamped(0, WRITE);
    await store.enqueue(lockCmd(LOCK, 'hlc2', true), [lockEffect(LOCK, 'hlc2', 1)]);
    await store.markApplied(LOCK, [{ table: 'journal_entries', row_id: ROW, op: 'update' }]);
    setStamped(0, UNLOCK); // someone unlocked it after us, elsewhere
    expect((await store.reconcileConfirmed()).cleared).toContain(LOCK);
    expect(await shownLocked()).toBe(0); // the newer truth, not our held lock
  });
});

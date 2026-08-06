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
 * journal_entries carries no `last_modified_by_command_id` in the client schema,
 * so reconcile confirms on row PRESENCE — which is why the loser's overlay clears
 * once the winning canonical row (its rewritten id) arrives.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqlOverlayStore, readMergedRows, type OverlayStore, type SqlExecutor } from '../src/index';
import type { ClientCommand, OverlayEffect } from '@prisms/core';

let db: Database.Database;
let store: OverlayStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE client_commands (id TEXT PRIMARY KEY, name TEXT, hlc TEXT, payload TEXT, status TEXT, created_at TEXT, command_version INTEGER, schema_version INTEGER, client_version TEXT, depends_on TEXT);
    CREATE TABLE overlay_effects (id TEXT PRIMARY KEY, command_id TEXT, hlc TEXT, table_name TEXT, row_id TEXT, op TEXT, fields TEXT, seq INTEGER, created_at TEXT);
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, user_id TEXT, entry_date TEXT, month_key TEXT, content TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
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

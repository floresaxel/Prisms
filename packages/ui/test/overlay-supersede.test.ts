/**
 * Two writes to the SAME row, on a REAL SQLite store so the actual
 * `createSqlOverlayStore` SQL runs.
 *
 * A canonical row records only its LAST modifier, so an applied command whose row
 * has since been written again could never see its own stamp and waited forever.
 * Its overlay was held indefinitely — and because `mergeRow` replays effects over
 * the canonical row in HLC order, that stranded OLDER effect kept overwriting the
 * newer value underneath it. Edit a field twice and the screen showed the first
 * value, permanently; a reload made it worse, because with an empty queue nothing
 * ran reconciliation again.
 *
 * Command ids are UUIDv7, so they sort by mint time and the comparison below is
 * the ordering the row itself does not carry.
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
    CREATE TABLE nodes (id TEXT PRIMARY KEY, title TEXT, attributes TEXT, last_modified_by_command_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
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

const ROW = 'vision-1';
// UUIDv7-shaped: the leading timestamp is what makes these sort by mint time.
const FIRST = '01a00845-689d-70f2-8e93-ac371cfc7dbf';
const SECOND = '01a00845-68e3-7be3-a4b0-406f4c1ee1dc';
// A v4 id (an import, an e2e seed — anything not minted by `newId`). It carries
// no timestamp, and this one happens to sort ABOVE both v7s above.
const V4_ABOVE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const cmd = (id: string, hlc: string): ClientCommand => ({
  id, name: 'node.set_attributes', hlc, payload: { id: ROW }, status: 'pending', created_at: '2026-08-16T00:00:00.000Z',
});
const attrEffect = (commandId: string, hlc: string, attributes: string): OverlayEffect => ({
  command_id: commandId, hlc, table: 'nodes', row_id: ROW, op: 'update', seq: 0, fields: { attributes },
});
/** The row as the server now has it, stamped by whichever command wrote it last. */
const setCanonical = (attributes: string, stamp: string) =>
  db.prepare('INSERT OR REPLACE INTO nodes (id, title, attributes, last_modified_by_command_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)')
    .run(ROW, 'Build a studio', attributes, stamp, 't', 't');
const shown = async () => (await readMergedRows(store, 'nodes')).find((r) => r['id'] === ROW)?.['attributes'];

describe('an applied overlay whose row was written again', () => {
  it('is cleared, and stops overwriting the newer value', async () => {
    // Two edits to one field, in order — the shape of any control that writes on
    // each interaction (a unit switch, then a preset).
    await store.enqueue(cmd(FIRST, 'hlc-1'), [attrEffect(FIRST, 'hlc-1', '{"amount":3}')]);
    await store.enqueue(cmd(SECOND, 'hlc-2'), [attrEffect(SECOND, 'hlc-2', '{"amount":9}')]);
    await store.markApplied(FIRST);
    await store.markApplied(SECOND);

    // The server took both; the row that syncs down carries the LATER stamp.
    setCanonical('{"amount":9}', SECOND);

    const { cleared } = await store.reconcileConfirmed();
    expect(cleared).toEqual(expect.arrayContaining([FIRST, SECOND]));
    expect(await shown()).toBe('{"amount":9}'); // not the 3 the first effect held
  });

  it('still waits when the row has NOT caught up yet', async () => {
    // The anti-flicker guarantee (S7-F6): a stamp OLDER than ours means our write
    // is still on its way down, so the overlay has to stay or the value reverts
    // in front of the user between ack and download.
    await store.enqueue(cmd(SECOND, 'hlc-2'), [attrEffect(SECOND, 'hlc-2', '{"amount":9}')]);
    await store.markApplied(SECOND);
    setCanonical('{"amount":3}', FIRST); // still the previous write

    const { cleared } = await store.reconcileConfirmed();
    expect(cleared).not.toContain(SECOND);
    expect(await shown()).toBe('{"amount":9}'); // the overlay is still doing its job
  });

  it('reads no ordering out of a non-v7 stamp', async () => {
    // Only v7 sorts by mint time; comparing a v4 id is a coin flip, and this one
    // lands above ours. Calling that "superseded" would drop the overlay before
    // our write syncs down, reverting the value in front of the user — so an
    // unreadable stamp waits, exactly as an exact-match check used to.
    await store.enqueue(cmd(SECOND, 'hlc-2'), [attrEffect(SECOND, 'hlc-2', '{"amount":9}')]);
    await store.markApplied(SECOND);
    setCanonical('{"amount":3}', V4_ABOVE);

    const { cleared } = await store.reconcileConfirmed();
    expect(cleared).not.toContain(SECOND);
    expect(await shown()).toBe('{"amount":9}');
  });

  it('clears on its own stamp, as before', async () => {
    await store.enqueue(cmd(FIRST, 'hlc-1'), [attrEffect(FIRST, 'hlc-1', '{"amount":3}')]);
    await store.markApplied(FIRST);
    setCanonical('{"amount":3}', FIRST);

    const { cleared } = await store.reconcileConfirmed();
    expect(cleared).toContain(FIRST);
    expect(await shown()).toBe('{"amount":3}');
  });
});

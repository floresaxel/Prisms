/**
 * Local-first Recently deleted, on a REAL SQLite store (better-sqlite3) so the
 * actual overlay + snapshot SQL runs. A task deleted on this device is listed
 * and comes back on screen from this device alone — with no sync at all, and
 * after its row has already left the replica (the delete synced, the history
 * stream not held). Then the pure list merge: the server's tombstones win, and
 * a node that is live again, under a deleted parent, or too old is not listed.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asEpochMillis, buildTreeIndex, type Node } from '@prisms/core';

import {
  buildSnapshot,
  createCommands,
  createSqlDeletedSnapshots,
  createSqlOverlayStore,
  listRecentlyDeleted,
  readMergedRows,
  restoreEffects,
  toDeletedSnapshot,
  type DeletedSnapshot,
  type OverlayStore,
  type SqlExecutor,
} from '../src/index';
import { toNode } from '../src/powersync/rows';

const U = 'u1';
const NOW = '2026-11-21T10:00:00.000Z';
const NOW_MS = asEpochMillis(Date.parse(NOW));
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const VISION = id(1);
const ROADMAP = id(2);
const PROJECT = id(3);
const TASK = id(4);
const OTHER = id(5);
const STEP = id(6);

let db: Database.Database;
let exec: SqlExecutor;
let store: OverlayStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE client_commands (id TEXT PRIMARY KEY, name TEXT, hlc TEXT, payload TEXT, status TEXT, created_at TEXT, command_version INTEGER, schema_version INTEGER, client_version TEXT, depends_on TEXT, reject_code TEXT, reject_reason TEXT);
    CREATE TABLE overlay_effects (id TEXT PRIMARY KEY, command_id TEXT, hlc TEXT, table_name TEXT, row_id TEXT, op TEXT, fields TEXT, seq INTEGER, created_at TEXT);
    CREATE TABLE deleted_snapshots (id TEXT PRIMARY KEY, deleted_at TEXT, nodes TEXT, steps TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, user_id TEXT, parent_id TEXT, node_type TEXT, title TEXT, description TEXT, sort_order TEXT, start_date TEXT, due_date TEXT, estimate_minutes INTEGER, completed_at TEXT, completion_disposition TEXT, completed_in_block_id TEXT, habit_id TEXT, attributes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, last_modified_by_command_id TEXT);
    CREATE TABLE task_steps (id TEXT PRIMARY KEY, user_id TEXT, task_id TEXT, title TEXT, done INTEGER, sort_order TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  `);
  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    db.prepare(sql).run(...(params as never[]));
  };
  const all = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => db.prepare(sql).all(...(params as never[])) as T[];
  const tx = { execute: run, getAll: all };
  exec = { execute: run, getAll: all, writeTransaction: async (fn) => fn(tx) };
  store = createSqlOverlayStore(exec);
  const node = (nid: string, type: string, parent: string | null, title: string, deletedAt: string | null = null) =>
    db
      .prepare(`INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, attributes, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,'','a0','{}',?,?,?)`)
      .run(nid, U, parent, type, title, NOW, NOW, deletedAt);
  node(VISION, 'vision', null, 'Work');
  node(ROADMAP, 'roadmap', VISION, 'Plan');
  node(PROJECT, 'project', ROADMAP, 'Garden');
  node(TASK, 'task', PROJECT, 'Lay the drip lines');
  node(OTHER, 'task', PROJECT, 'Order mulch');
  db.prepare(`INSERT INTO task_steps (id, user_id, task_id, title, done, sort_order, created_at, updated_at, deleted_at) VALUES (?,?,?,?,0,'a0',?,?,NULL)`).run(STEP, U, TASK, 'Measure the runs', NOW, NOW);
});
afterEach(() => db.close());

let n = 0;
const commandsFor = () =>
  createCommands(
    store,
    { userId: U, deviceId: 'web-1', now: () => NOW },
    { mintId: () => `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`, nextHlc: () => `hlc-${String(n).padStart(6, '0')}`, now: () => NOW },
    { snapshots: createSqlDeletedSnapshots(exec, () => NOW_MS) },
  );

async function mergedTree() {
  return buildTreeIndex((await readMergedRows(store, 'nodes')).map((r) => toNode(r)));
}
async function listed() {
  const nodeRows = await readMergedRows(store, 'nodes');
  const snapshots = (db.prepare('SELECT * FROM deleted_snapshots').all() as Record<string, unknown>[]).map(toDeletedSnapshot);
  return listRecentlyDeleted({ tree: buildTreeIndex(nodeRows.map((r) => toNode(r))), nodeRows, snapshots, now: NOW_MS });
}
const liveSteps = async () => (await readMergedRows(store, 'task_steps')).filter((s) => s['deleted_at'] == null).map((s) => s['title']);

describe('local-first Recently deleted (real SQLite, no sync)', () => {
  it('a task deleted here is listed at once and restores on screen, steps included, with no server', async () => {
    const commands = commandsFor();
    await commands.softDelete(TASK);
    expect((await mergedTree()).byId.has(TASK)).toBe(false); // hidden

    const items = await listed();
    expect(items.map((i) => i.task.id)).toEqual([TASK]);
    expect(items[0]).toMatchObject({ localOnly: true, projectTitle: 'Garden', deletedAt: NOW });
    expect(items[0]!.task.title).toBe('Lay the drip lines');

    await commands.restore(TASK);
    const back = (await mergedTree()).byId.get(TASK);
    expect(back?.title).toBe('Lay the drip lines');
    expect(back?.deleted_at).toBeNull();
    expect(await liveSteps()).toEqual(['Measure the runs']);
    expect(await listed()).toEqual([]); // live again → not listed
    // both commands wait in the queue for the server
    expect((await store.pendingCommands()).map((c) => c.name)).toEqual(['node.soft_delete', 'node.restore']);
  });

  it('restores from the snapshot even after the row has left this device (the delete synced, history not held)', async () => {
    const commands = commandsFor();
    await commands.softDelete(TASK);
    // the server took the delete: the row and its step left the replica; the overlay is gone
    db.prepare('DELETE FROM nodes WHERE id = ?').run(TASK);
    db.prepare('DELETE FROM task_steps WHERE id = ?').run(STEP);
    db.prepare('DELETE FROM overlay_effects').run();
    db.prepare('DELETE FROM client_commands').run();

    expect((await listed()).map((i) => i.task.id)).toEqual([TASK]); // still listed, from this device
    await commands.restore(TASK);
    expect((await mergedTree()).byId.get(TASK)?.title).toBe('Lay the drip lines');
    expect(await liveSteps()).toEqual(['Measure the runs']);
  });

  it('a task deleted again replaces its snapshot; snapshots past 30 days are pruned on the next save', async () => {
    const snapshots = createSqlDeletedSnapshots(exec, () => NOW_MS);
    await snapshots.save({ id: OTHER, deletedAt: '2026-10-01T00:00:00.000Z', nodes: [], steps: [] }); // 51 days old
    await snapshots.save({ id: TASK, deletedAt: '2026-11-20T00:00:00.000Z', nodes: [], steps: [] });
    await snapshots.save({ id: TASK, deletedAt: NOW, nodes: [], steps: [] });
    const rows = db.prepare('SELECT id, deleted_at FROM deleted_snapshots').all();
    expect(rows).toEqual([{ id: TASK, deleted_at: NOW }]);
  });
});

describe('buildSnapshot / restoreEffects', () => {
  const rowsOf = (nodes: Partial<Node>[]) => nodes.map((x) => ({ attributes: '{}', description: '', sort_order: 'a0', deleted_at: null, ...x }) as Record<string, unknown>);

  it('snapshots the delete closure (I10) and only those tasks’ live steps', () => {
    const rows = rowsOf([
      { id: PROJECT, node_type: 'project', parent_id: null, title: 'Garden' },
      { id: TASK, node_type: 'task', parent_id: PROJECT, title: 'A' },
    ]);
    const steps = [
      { id: STEP, task_id: TASK, deleted_at: null },
      { id: id(7), task_id: TASK, deleted_at: '2026-11-01T00:00:00.000Z' },
      { id: id(8), task_id: OTHER, deleted_at: null },
    ];
    const s = buildSnapshot(rows, steps, PROJECT, NOW)!;
    expect(s.nodes.map((r) => r['id'])).toEqual([PROJECT, TASK]);
    expect(s.steps.map((r) => r['id'])).toEqual([STEP]);
    expect(buildSnapshot(rows, steps, id(99), NOW)).toBeNull();
  });

  it('with a snapshot: whole-row inserts, live again; without: un-deletes the same-cascade tombstones', () => {
    const snap: DeletedSnapshot = { id: TASK, deletedAt: NOW, nodes: [{ id: TASK, title: 'A', deleted_at: null }], steps: [{ id: STEP, task_id: TASK }] };
    expect(restoreEffects(TASK, snap, [])).toEqual([
      { table: 'nodes', row_id: TASK, op: 'insert', fields: { id: TASK, title: 'A', deleted_at: null } },
      { table: 'task_steps', row_id: STEP, op: 'insert', fields: { id: STEP, task_id: TASK, deleted_at: null } },
    ]);
    const tombs = rowsOf([
      { id: PROJECT, node_type: 'project', parent_id: null, deleted_at: NOW },
      { id: TASK, node_type: 'task', parent_id: PROJECT, deleted_at: NOW },
      { id: OTHER, node_type: 'task', parent_id: PROJECT, deleted_at: '2026-11-01T00:00:00.000Z' }, // deleted on its own earlier
    ]);
    expect(restoreEffects(PROJECT, null, tombs)).toEqual([{ table: 'nodes', row_id: TASK, op: 'update', fields: { deleted_at: null } }]);
  });
});

describe('listRecentlyDeleted', () => {
  const live = rowsLive();
  function rowsLive() {
    return [
      { id: PROJECT, node_type: 'project', parent_id: null, title: 'Garden', sort_order: 'a0', deleted_at: null, attributes: '{}' },
    ] as Record<string, unknown>[];
  }
  const snap = (nid: string, parent: string | null, deletedAt: string): DeletedSnapshot => ({
    id: nid,
    deletedAt,
    nodes: [{ id: nid, node_type: 'task', parent_id: parent, title: `t-${nid.slice(-2)}`, sort_order: 'a0', deleted_at: null, attributes: '{}' }],
    steps: [],
  });
  const list = (nodeRows: Record<string, unknown>[], snapshots: DeletedSnapshot[]) =>
    listRecentlyDeleted({ tree: buildTreeIndex(nodeRows.map((r) => toNode(r))), nodeRows, snapshots, now: NOW_MS });

  it("the server's tombstone wins over this device's snapshot (one entry, its stamp)", () => {
    const tomb = { id: TASK, node_type: 'task', parent_id: PROJECT, title: 'A', sort_order: 'a0', deleted_at: '2026-11-21T09:59:59.000Z', attributes: '{}' };
    const items = list([...live, tomb], [snap(TASK, PROJECT, NOW)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ localOnly: false, deletedAt: '2026-11-21T09:59:59.000Z', projectTitle: 'Garden' });
  });

  it('skips a node that is live again, one under a deleted parent, and one past 30 days; newest first', () => {
    const liveAgain = { id: OTHER, node_type: 'task', parent_id: PROJECT, title: 'B', sort_order: 'a1', deleted_at: null, attributes: '{}' };
    const items = list(
      [...live, liveAgain],
      [
        snap(OTHER, PROJECT, NOW), // restored since
        snap(id(10), id(99), NOW), // parent gone
        snap(id(11), PROJECT, '2026-10-01T00:00:00.000Z'), // too old
        snap(id(12), null, '2026-11-20T00:00:00.000Z'), // an Inbox capture, older
        snap(id(13), PROJECT, NOW),
      ],
    );
    expect(items.map((i) => i.task.id)).toEqual([id(13), id(12)]);
    expect(items[1]!.projectTitle).toBeNull();
  });
});

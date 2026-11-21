/**
 * Tasks › Recently deleted, local-first: this device's own record of what it
 * deleted (the local-only `deleted_snapshots` table, schema.ts).
 *
 * The server keeps a deleted row as a tombstone that only reaches a device
 * through the lazy `history` stream — so, alone, a task deleted HERE could not
 * be listed, nor shown again on restore, while sync is down (offline, or the
 * server refusing an expired sign-in). `softDelete` therefore snapshots the
 * rows it is about to hide, and `restore` replays that snapshot as optimistic
 * inserts, so the task is back on screen at once and the `node.restore`
 * command catches the server up whenever it can.
 *
 * Pure builders (`buildSnapshot`, `restoreEffects`) plus a tiny SQL store over
 * the same `SqlTx` seam as the overlay store, so it unit-tests without PowerSync.
 */
import { ancestorsOf, buildTreeIndex, isoToEpochMillis, restoreClosure, softDeleteClosure, type Instant, type Node, type TreeIndex } from '@prisms/core';

import type { EffectSpec } from './effects';
import type { SqlTx } from './overlay-store';
import { toNode } from './rows';

/** How long this device keeps what it deleted (and how far back the list reaches). */
export const RECENTLY_DELETED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

export interface DeletedSnapshot {
  /** The deleted root node's id. */
  id: string;
  /** ISO, when it was deleted on this device. */
  deletedAt: string;
  /** The node rows the delete hid — root first, then its cascade — as they were (live). */
  nodes: Row[];
  /** Those tasks' live checklist step rows. */
  steps: Row[];
}

/**
 * The snapshot to keep for deleting `rootId`, from the MERGED rows (replica +
 * pending writes) as they are just before the delete: the same closure the
 * delete cascades over (I10), and the live steps of those nodes. Null when the
 * root isn't here or is already deleted.
 */
export function buildSnapshot(nodeRows: readonly Row[], stepRows: readonly Row[], rootId: string, deletedAt: string): DeletedSnapshot | null {
  const ids = softDeleteClosure(buildTreeIndex(nodeRows.map((r) => toNode(r))), rootId);
  if (ids.length === 0) return null;
  const byId = new Map(nodeRows.map((r) => [String(r['id']), r] as const));
  const nodes = ids.map((id) => byId.get(id)).filter((r): r is Row => r !== undefined);
  const inClosure = new Set(ids);
  const steps = stepRows.filter((s) => inClosure.has(String(s['task_id'])) && s['deleted_at'] == null);
  return { id: rootId, deletedAt, nodes, steps };
}

/**
 * The optimistic effects that put a deleted task back on screen at once.
 *
 * With this device's snapshot: each of its rows as a WHOLE-row insert (live
 * again), which stands in for a row the device no longer holds and overrides a
 * still-pending delete (it sorts after it). Without one (deleted on another
 * device; only the synced tombstones are here): patch `deleted_at` back on the
 * tombstones of the same cascade, the inverse of what the server will do.
 * Either way the server's `node.restore` reconciles these away when it lands.
 */
export function restoreEffects(rootId: string, snapshot: DeletedSnapshot | null, mergedNodeRows: readonly Row[]): EffectSpec[] {
  if (snapshot) {
    return [
      ...snapshot.nodes.map((r): EffectSpec => ({ table: 'nodes', row_id: String(r['id']), op: 'insert', fields: { ...r, deleted_at: null } })),
      ...snapshot.steps.map((r): EffectSpec => ({ table: 'task_steps', row_id: String(r['id']), op: 'insert', fields: { ...r, deleted_at: null } })),
    ];
  }
  return restoreClosure(mergedNodeRows.map((r) => toNode(r)), rootId)
    .filter((id) => id !== rootId) // the command's own effect covers the root
    .map((id): EffectSpec => ({ table: 'nodes', row_id: id, op: 'update', fields: { deleted_at: null } }));
}

/** The parent project of a task (or of a deleted task's live parent), or null. */
export function projectAbove(tree: TreeIndex, node: Node): Node | null {
  if (node.parent_id === null) return null;
  const parent = tree.byId.get(node.parent_id);
  if (!parent) return null;
  if (parent.node_type === 'project') return parent;
  return ancestorsOf(tree, parent.id).find((a) => a.node_type === 'project') ?? null;
}

export interface DeletedTaskItem {
  task: Node;
  /** When it was deleted: the server's stamp when its tombstone is here, else this device's. */
  deletedAt: string;
  projectId: string | null;
  projectTitle: string | null;
  /** Known only from this device's snapshot (the server's tombstone hasn't reached it). */
  localOnly: boolean;
}

/**
 * Tasks › Recently deleted: tasks and Inbox captures deleted in the last
 * RECENTLY_DELETED_DAYS, newest first — merged from this device's snapshots
 * and the synced tombstones (`nodeRows`, the merged node set, which holds them
 * while the history stream is held), one entry per node. Only the ones
 * `node.restore` can bring back on their own: a node at the Inbox (no parent)
 * or under a parent that is still live — a task deleted with its project comes
 * back with the project. A node that is live again (restored here or on
 * another device, or a rejected delete) is not listed.
 */
export function listRecentlyDeleted(args: { tree: TreeIndex; nodeRows: readonly Row[]; snapshots: readonly DeletedSnapshot[]; now: Instant }): DeletedTaskItem[] {
  const { tree, now } = args;
  const since = now - RECENTLY_DELETED_DAYS * DAY_MS;
  const byId = new Map<string, DeletedTaskItem>();
  const consider = (node: Node, deletedAt: string, localOnly: boolean) => {
    if (node.node_type !== 'task' && node.node_type !== 'activity') return;
    if (tree.byId.has(node.id)) return; // live again
    if (isoToEpochMillis(deletedAt) < since) return;
    if (node.parent_id !== null && !tree.byId.has(node.parent_id)) return; // goes back with its parent
    const project = projectAbove(tree, node);
    byId.set(node.id, { task: { ...node, deleted_at: deletedAt }, deletedAt, projectId: project?.id ?? null, projectTitle: project?.title ?? null, localOnly });
  };
  for (const s of args.snapshots) {
    const root = s.nodes.find((r) => String(r['id']) === s.id);
    if (root && s.deletedAt) consider(toNode(root), s.deletedAt, true);
  }
  // the server's tombstones win: they are the authority, and carry its stamp
  for (const row of args.nodeRows) {
    const node = toNode(row);
    if (node.deleted_at !== null) consider(node, node.deleted_at, false);
  }
  return [...byId.values()].sort((a, b) => (b.deletedAt < a.deletedAt ? -1 : b.deletedAt > a.deletedAt ? 1 : a.task.id < b.task.id ? -1 : 1));
}

const parseRows = (value: unknown): Row[] => {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Row[]) : [];
  } catch {
    return [];
  }
};

/** A `deleted_snapshots` row as read from SQLite. */
export function toDeletedSnapshot(row: Row): DeletedSnapshot {
  return { id: String(row['id']), deletedAt: String(row['deleted_at'] ?? ''), nodes: parseRows(row['nodes']), steps: parseRows(row['steps']) };
}

export interface DeletedSnapshotStore {
  /** Keep (or replace — a node deleted again) a snapshot, and drop ones past RECENTLY_DELETED_DAYS. */
  save(snapshot: DeletedSnapshot): Promise<void>;
  get(id: string): Promise<DeletedSnapshot | null>;
}

export function createSqlDeletedSnapshots(sql: SqlTx, nowMs: () => number = Date.now): DeletedSnapshotStore {
  return {
    async save(s) {
      await sql.execute('INSERT OR REPLACE INTO deleted_snapshots (id, deleted_at, nodes, steps) VALUES (?, ?, ?, ?)', [
        s.id,
        s.deletedAt,
        JSON.stringify(s.nodes),
        JSON.stringify(s.steps),
      ]);
      const cutoff = new Date(nowMs() - RECENTLY_DELETED_DAYS * DAY_MS).toISOString();
      await sql.execute('DELETE FROM deleted_snapshots WHERE deleted_at < ?', [cutoff]);
    },
    async get(id) {
      const [row] = await sql.getAll<Row>('SELECT * FROM deleted_snapshots WHERE id = ? LIMIT 1', [id]);
      return row ? toDeletedSnapshot(row) : null;
    },
  };
}

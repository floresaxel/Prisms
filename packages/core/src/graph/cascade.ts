/**
 * Soft-delete closure — invariant I10 (ARCHITECTURE.md §6.7).
 *
 * `deleted_at` cascades logically down the subtree: core computes the
 * closure, the mutation marks every returned row (client and server run the
 * same function). Only LIVE nodes are returned — already-deleted rows must
 * not be rewritten (minimal-field mutations, §2 principle 8), and nodes
 * orphaned under a previously deleted ancestor are unreachable here (their
 * own earlier cascade is responsible for them).
 */
import type { Node } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { compareSiblings, subtreeOf, type TreeIndex } from './tree';

/**
 * Ids to mark deleted when soft-deleting `rootId`: the root plus all live
 * descendants, in deterministic pre-order. Empty when the root is missing
 * or already deleted.
 */
export function softDeleteClosure(index: TreeIndex, rootId: Uuid): Uuid[] {
  return subtreeOf(index, rootId).map((node) => node.id);
}

/**
 * Ids to bring back when restoring the soft-deleted `rootId` — the inverse of
 * `softDeleteClosure`: the root plus the descendants that ONE cascade deleted,
 * told apart by their shared `deleted_at` stamp. A child deleted on its own
 * earlier keeps its own (different) stamp and stays deleted. Takes RAW rows
 * (live and deleted: a TreeIndex holds only live ones), deterministic
 * pre-order, cycle-safe. Empty when the root is missing or not deleted.
 */
export function restoreClosure(rows: Iterable<Node>, rootId: Uuid): Uuid[] {
  const all = [...rows];
  const root = all.find((n) => n.id === rootId);
  if (root === undefined || root.deleted_at === null) return [];
  const stamp = root.deleted_at;
  const children = new Map<Uuid, Node[]>();
  for (const n of all) {
    if (n.deleted_at !== stamp || n.parent_id === null || n.id === rootId) continue;
    const list = children.get(n.parent_id);
    if (list) list.push(n);
    else children.set(n.parent_id, [n]);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  const out: Uuid[] = [];
  const seen = new Set<Uuid>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node.id);
    const kids = children.get(node.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as Node);
  }
  return out;
}

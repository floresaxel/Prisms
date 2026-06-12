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
import type { Uuid } from '../domain/primitives';
import { subtreeOf, type TreeIndex } from './tree';

/**
 * Ids to mark deleted when soft-deleting `rootId`: the root plus all live
 * descendants, in deterministic pre-order. Empty when the root is missing
 * or already deleted.
 */
export function softDeleteClosure(index: TreeIndex, rootId: Uuid): Uuid[] {
  return subtreeOf(index, rootId).map((node) => node.id);
}

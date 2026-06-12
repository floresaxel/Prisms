/**
 * Tree (containment) queries over in-memory fact sets (ARCHITECTURE.md §6,
 * BUILD_PLAN s04).
 *
 * `buildTreeIndex` ingests raw `nodes` rows and indexes the LIVE ones
 * (deleted_at IS NULL), mirroring the partial indexes in §6.0. All walks are
 * iterative and cycle-safe: synced fact sets can be transiently inconsistent
 * (e.g. a parent loop merged from two offline devices), and a query must
 * never hang on corrupt data — commands prevent such states, sync repair
 * resolves them.
 *
 * Determinism: siblings order by (sort_order, id); two devices holding the
 * same rows always see identical orderings (§2 principle 7).
 */
import type { Node } from '../domain/entities';
import type { Uuid } from '../domain/primitives';

export interface TreeIndex {
  /** Live nodes by id. */
  readonly byId: ReadonlyMap<Uuid, Node>;
  /** Live children by parent id (null = roots), sorted by (sort_order, id). */
  readonly childrenByParent: ReadonlyMap<Uuid | null, readonly Node[]>;
}

/** Sibling order: fractional sort_order, then id as the cross-device tiebreak. */
export function compareSiblings(a: Node, b: Node): -1 | 0 | 1 {
  if (a.sort_order !== b.sort_order) return a.sort_order < b.sort_order ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function buildTreeIndex(rows: Iterable<Node>): TreeIndex {
  const byId = new Map<Uuid, Node>();
  for (const row of rows) {
    if (row.deleted_at === null) byId.set(row.id, row);
  }
  const childrenByParent = new Map<Uuid | null, Node[]>();
  for (const node of byId.values()) {
    const siblings = childrenByParent.get(node.parent_id);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenByParent.set(node.parent_id, [node]);
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareSiblings);
  }
  return { byId, childrenByParent };
}

export function getNode(index: TreeIndex, id: Uuid): Node | undefined {
  return index.byId.get(id);
}

/** Live children of a parent (null = root nodes), in sibling order. */
export function childrenOf(
  index: TreeIndex,
  parentId: Uuid | null,
): readonly Node[] {
  return index.childrenByParent.get(parentId) ?? [];
}

/**
 * Ancestors nearest-first (parent, grandparent, …). Excludes the node
 * itself; stops at a missing parent or on a corrupt parent loop.
 */
export function ancestorsOf(index: TreeIndex, id: Uuid): Node[] {
  const ancestors: Node[] = [];
  const seen = new Set<Uuid>([id]);
  let current = index.byId.get(id);
  while (current !== undefined && current.parent_id !== null) {
    if (seen.has(current.parent_id)) break;
    const parent = index.byId.get(current.parent_id);
    if (parent === undefined) break;
    ancestors.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return ancestors;
}

/**
 * The live subtree rooted at `rootId` in depth-first pre-order (root first,
 * children in sibling order). Empty when the root is missing or deleted.
 */
export function subtreeOf(index: TreeIndex, rootId: Uuid): Node[] {
  const root = index.byId.get(rootId);
  if (root === undefined) return [];
  const out: Node[] = [];
  const seen = new Set<Uuid>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    const children = childrenOf(index, node.id);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i] as Node);
    }
  }
  return out;
}

/** `subtreeOf` minus the root itself. */
export function descendantsOf(index: TreeIndex, rootId: Uuid): Node[] {
  return subtreeOf(index, rootId).slice(1);
}

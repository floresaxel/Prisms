/**
 * Dependency graph (edges) — invariant I4 (ARCHITECTURE.md §6.7).
 *
 * `edges` must form a DAG and connect nodes of the same node_type
 * (task↔task, project↔project). `validateEdge` is the single I4 gate used
 * by both the client and the server on `edge.create`; cycle detection runs
 * on insert, so an in-variant fact set never admits a cycle (property-
 * tested). Walks are iterative and tolerate cyclic input — transient
 * inconsistency can occur mid-sync when two offline devices each created
 * half of a cycle, until the server rejects the later command.
 */
import type { Edge } from '../domain/entities';
import { domainError } from '../domain/errors';
import type { Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import { getNode, type TreeIndex } from './tree';

export interface EdgeIndex {
  /** Live edges by id. */
  readonly byId: ReadonlyMap<Uuid, Edge>;
  /** Live edges grouped by predecessor, sorted by edge id. */
  readonly outgoing: ReadonlyMap<Uuid, readonly Edge[]>;
  /** Live edges grouped by successor, sorted by edge id. */
  readonly incoming: ReadonlyMap<Uuid, readonly Edge[]>;
}

function compareById(a: Edge, b: Edge): -1 | 0 | 1 {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function buildEdgeIndex(rows: Iterable<Edge>): EdgeIndex {
  const byId = new Map<Uuid, Edge>();
  for (const row of rows) {
    if (row.deleted_at === null) byId.set(row.id, row);
  }
  const outgoing = new Map<Uuid, Edge[]>();
  const incoming = new Map<Uuid, Edge[]>();
  for (const edge of byId.values()) {
    const out = outgoing.get(edge.predecessor_id);
    if (out) out.push(edge);
    else outgoing.set(edge.predecessor_id, [edge]);
    const inc = incoming.get(edge.successor_id);
    if (inc) inc.push(edge);
    else incoming.set(edge.successor_id, [edge]);
  }
  for (const list of outgoing.values()) list.sort(compareById);
  for (const list of incoming.values()) list.sort(compareById);
  return { byId, outgoing, incoming };
}

export function outgoingEdges(index: EdgeIndex, nodeId: Uuid): readonly Edge[] {
  return index.outgoing.get(nodeId) ?? [];
}

export function incomingEdges(index: EdgeIndex, nodeId: Uuid): readonly Edge[] {
  return index.incoming.get(nodeId) ?? [];
}

/** BFS over successor direction. */
export function isReachable(index: EdgeIndex, fromId: Uuid, toId: Uuid): boolean {
  if (fromId === toId) return true;
  const seen = new Set<Uuid>([fromId]);
  const queue: Uuid[] = [fromId];
  while (queue.length > 0) {
    const current = queue.shift() as Uuid;
    for (const edge of outgoingEdges(index, current)) {
      const next = edge.successor_id;
      if (next === toId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Would adding predecessor→successor close a cycle? (Self-edges always do.) */
export function wouldCreateCycle(
  index: EdgeIndex,
  predecessorId: Uuid,
  successorId: Uuid,
): boolean {
  return isReachable(index, successorId, predecessorId);
}

export function findEdgeBetween(
  index: EdgeIndex,
  predecessorId: Uuid,
  successorId: Uuid,
): Edge | undefined {
  return outgoingEdges(index, predecessorId).find(
    (edge) => edge.successor_id === successorId,
  );
}

/**
 * The I4 gate for `edge.create`: endpoints exist, same node_type, no
 * duplicate pair (§6.0 UNIQUE), and no cycle.
 */
export function validateEdge(
  tree: TreeIndex,
  edges: EdgeIndex,
  candidate: Pick<Edge, 'predecessor_id' | 'successor_id'>,
): Result<void> {
  const predecessor = getNode(tree, candidate.predecessor_id);
  if (predecessor === undefined) {
    return err(
      domainError('E_NOT_FOUND', `predecessor ${candidate.predecessor_id} does not exist`),
    );
  }
  const successor = getNode(tree, candidate.successor_id);
  if (successor === undefined) {
    return err(
      domainError('E_NOT_FOUND', `successor ${candidate.successor_id} does not exist`),
    );
  }
  if (predecessor.node_type !== successor.node_type) {
    return err(
      domainError(
        'E_EDGE_TYPE_MISMATCH',
        `edges connect nodes of the same type; got ${predecessor.node_type} → ${successor.node_type} (I4)`,
      ),
    );
  }
  if (findEdgeBetween(edges, candidate.predecessor_id, candidate.successor_id)) {
    return err(
      domainError(
        'E_DUPLICATE',
        'an edge between these nodes already exists (UNIQUE predecessor_id, successor_id)',
      ),
    );
  }
  if (wouldCreateCycle(edges, candidate.predecessor_id, candidate.successor_id)) {
    return err(
      domainError('E_CYCLE', 'adding this dependency would create a cycle (I4)'),
    );
  }
  return ok(undefined);
}

/**
 * Kahn topological order over `nodeIds`, considering only edges whose both
 * endpoints are in the set. Deterministic: among ready nodes the smallest id
 * goes first. Errs with E_CYCLE on cyclic input.
 */
export function topologicalOrder(
  index: EdgeIndex,
  nodeIds: Iterable<Uuid>,
): Result<Uuid[]> {
  const inSet = new Set<Uuid>(nodeIds);
  const inDegree = new Map<Uuid, number>();
  for (const id of inSet) {
    let degree = 0;
    for (const edge of incomingEdges(index, id)) {
      if (inSet.has(edge.predecessor_id)) degree += 1;
    }
    inDegree.set(id, degree);
  }
  const ready: Uuid[] = [...inSet].filter((id) => inDegree.get(id) === 0);
  ready.sort();
  const order: Uuid[] = [];
  while (ready.length > 0) {
    // smallest id first — `ready` is kept sorted ascending
    const current = ready.shift() as Uuid;
    order.push(current);
    for (const edge of outgoingEdges(index, current)) {
      const next = edge.successor_id;
      if (!inSet.has(next)) continue;
      const remaining = (inDegree.get(next) as number) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        // insert keeping ascending order (sets are small; clarity over heaps)
        let at = ready.length;
        while (at > 0 && (ready[at - 1] as Uuid) > next) at -= 1;
        ready.splice(at, 0, next);
      }
    }
  }
  if (order.length !== inSet.size) {
    return err(
      domainError('E_CYCLE', 'dependency graph contains a cycle', {
        unresolved: [...inSet].filter((id) => !order.includes(id)).sort(),
      }),
    );
  }
  return ok(order);
}

export function hasCycle(index: EdgeIndex, nodeIds: Iterable<Uuid>): boolean {
  return !topologicalOrder(index, nodeIds).ok;
}

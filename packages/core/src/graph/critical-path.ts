/**
 * Critical path (§12.2): the longest path over task estimates, computed in
 * core on demand for the Gantt view.
 *
 * Weights: each node contributes `estimate_minutes ?? 0`; traversed edges
 * contribute their `lag_minutes` (positive lag lengthens the path, negative
 * lead shortens it — §10 schedules "dependency order with lag").
 *
 * Deterministic: ties (equal path lengths) resolve toward the smaller node
 * id, so every device reports the identical path (§2 principle 7). Errs
 * with E_CYCLE on cyclic input rather than guessing.
 */
import type { Edge, Node } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { ok, type Result } from '../domain/result';
import { buildEdgeIndex, incomingEdges, topologicalOrder } from './dag';

export interface CriticalPath {
  /** Total minutes along the path (estimates + lags). */
  readonly totalMinutes: number;
  /** Node ids from path start to path end; empty for an empty task set. */
  readonly nodeIds: readonly Uuid[];
}

export function criticalPath(
  tasks: readonly Node[],
  edges: readonly Edge[],
): Result<CriticalPath> {
  const live = tasks.filter((t) => t.deleted_at === null);
  if (live.length === 0) return ok({ totalMinutes: 0, nodeIds: [] });

  const byId = new Map<Uuid, Node>(live.map((t) => [t.id, t]));
  const edgeIndex = buildEdgeIndex(
    edges.filter(
      (e) => byId.has(e.predecessor_id) && byId.has(e.successor_id),
    ),
  );

  const orderResult = topologicalOrder(edgeIndex, byId.keys());
  if (!orderResult.ok) return orderResult;

  const estimateOf = (id: Uuid): number => {
    const node = byId.get(id) as Node;
    return Math.max(node.estimate_minutes ?? 0, 0);
  };

  const distance = new Map<Uuid, number>();
  const bestPredecessor = new Map<Uuid, Uuid | null>();
  for (const id of orderResult.value) {
    let best = 0;
    let from: Uuid | null = null;
    for (const edge of incomingEdges(edgeIndex, id)) {
      if (!byId.has(edge.predecessor_id)) continue;
      const viaLength =
        (distance.get(edge.predecessor_id) as number) + edge.lag_minutes;
      // Ties prefer a real predecessor (zero-weight chain members stay on the
      // path), then the smaller predecessor id; order-independent.
      if (
        viaLength > best ||
        (viaLength === best && (from === null || edge.predecessor_id < from))
      ) {
        best = viaLength;
        from = edge.predecessor_id;
      }
    }
    distance.set(id, best + estimateOf(id));
    bestPredecessor.set(id, from);
  }

  let endId: Uuid | null = null;
  let total = -Infinity;
  for (const [id, dist] of distance) {
    if (dist > total || (dist === total && endId !== null && id < endId)) {
      total = dist;
      endId = id;
    }
  }

  const nodeIds: Uuid[] = [];
  let cursor: Uuid | null = endId;
  while (cursor !== null) {
    nodeIds.push(cursor);
    cursor = bestPredecessor.get(cursor) ?? null;
  }
  nodeIds.reverse();

  return ok({ totalMinutes: total, nodeIds });
}

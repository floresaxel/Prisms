/**
 * S4 DoD: property test — a random edge insert sequence gated by
 * `validateEdge` never admits a cycle (with an oracle check that every
 * E_CYCLE rejection really would have closed one).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Edge } from '../../src/domain/entities';
import {
  buildEdgeIndex,
  hasCycle,
  incomingEdges,
  isReachable,
  outgoingEdges,
  topologicalOrder,
  validateEdge,
  wouldCreateCycle,
} from '../../src/graph/dag';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeEdge, makeNode } from '../helpers/fixtures';

const TASK_COUNT = 12;
const tasks = Array.from({ length: TASK_COUNT }, (_, i) =>
  makeNode({ id: idOf(i + 1), node_type: 'task' }),
);
const taskIds = tasks.map((t) => t.id);
const tree = buildTreeIndex(tasks);

describe('validateEdge (I4) unit cases', () => {
  const project = makeNode({ id: idOf(100), node_type: 'project' });
  const mixedTree = buildTreeIndex([...tasks, project]);

  it('accepts a plain task→task dependency', () => {
    expect(
      validateEdge(mixedTree, buildEdgeIndex([]), {
        predecessor_id: idOf(1),
        successor_id: idOf(2),
      }).ok,
    ).toBe(true);
  });

  it('rejects mixed node types with E_EDGE_TYPE_MISMATCH', () => {
    const verdict = validateEdge(mixedTree, buildEdgeIndex([]), {
      predecessor_id: idOf(1),
      successor_id: project.id,
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_EDGE_TYPE_MISMATCH');
  });

  it('rejects missing endpoints with E_NOT_FOUND', () => {
    const missingPred = validateEdge(mixedTree, buildEdgeIndex([]), {
      predecessor_id: idOf(999),
      successor_id: idOf(1),
    });
    expect(!missingPred.ok && missingPred.error.code).toBe('E_NOT_FOUND');
    const missingSucc = validateEdge(mixedTree, buildEdgeIndex([]), {
      predecessor_id: idOf(1),
      successor_id: idOf(999),
    });
    expect(!missingSucc.ok && missingSucc.error.code).toBe('E_NOT_FOUND');
  });

  it('rejects duplicate pairs with E_DUPLICATE', () => {
    const edges = buildEdgeIndex([
      makeEdge({ id: idOf(200), predecessor_id: idOf(1), successor_id: idOf(2) }),
    ]);
    const verdict = validateEdge(mixedTree, edges, {
      predecessor_id: idOf(1),
      successor_id: idOf(2),
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_DUPLICATE');
    // the reverse direction is a cycle, not a duplicate
    const reverse = validateEdge(mixedTree, edges, {
      predecessor_id: idOf(2),
      successor_id: idOf(1),
    });
    expect(!reverse.ok && reverse.error.code).toBe('E_CYCLE');
  });

  it('rejects self-edges with E_CYCLE', () => {
    const verdict = validateEdge(mixedTree, buildEdgeIndex([]), {
      predecessor_id: idOf(1),
      successor_id: idOf(1),
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_CYCLE');
  });

  it('rejects closing a longer cycle with E_CYCLE', () => {
    const edges = buildEdgeIndex([
      makeEdge({ id: idOf(200), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(201), predecessor_id: idOf(2), successor_id: idOf(3) }),
    ]);
    const verdict = validateEdge(mixedTree, edges, {
      predecessor_id: idOf(3),
      successor_id: idOf(1),
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_CYCLE');
  });

  it('ignores soft-deleted edges entirely', () => {
    const edges = buildEdgeIndex([
      makeEdge({
        id: idOf(200),
        predecessor_id: idOf(1),
        successor_id: idOf(2),
        deleted_at: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    expect(outgoingEdges(edges, idOf(1))).toEqual([]);
    expect(incomingEdges(edges, idOf(2))).toEqual([]);
    // neither a duplicate nor a cycle source
    expect(
      validateEdge(mixedTree, edges, {
        predecessor_id: idOf(1),
        successor_id: idOf(2),
      }).ok,
    ).toBe(true);
    expect(
      validateEdge(mixedTree, edges, {
        predecessor_id: idOf(2),
        successor_id: idOf(1),
      }).ok,
    ).toBe(true);
  });
});

describe('reachability and topological order', () => {
  const edges = buildEdgeIndex([
    makeEdge({ id: idOf(200), predecessor_id: idOf(1), successor_id: idOf(2) }),
    makeEdge({ id: idOf(201), predecessor_id: idOf(2), successor_id: idOf(4) }),
    makeEdge({ id: idOf(202), predecessor_id: idOf(1), successor_id: idOf(3) }),
    makeEdge({ id: idOf(203), predecessor_id: idOf(3), successor_id: idOf(4) }),
  ]);

  it('isReachable follows the successor direction only', () => {
    expect(isReachable(edges, idOf(1), idOf(4))).toBe(true);
    expect(isReachable(edges, idOf(4), idOf(1))).toBe(false);
    expect(isReachable(edges, idOf(2), idOf(3))).toBe(false);
  });

  it('topologicalOrder is deterministic (smallest ready id first)', () => {
    const order = topologicalOrder(edges, [idOf(4), idOf(3), idOf(2), idOf(1), idOf(5)]);
    // smallest ready id first: after 1, both 2 and 3 unlock and sort before
    // the isolated 5; input order is irrelevant.
    expect(order.ok && order.value).toEqual([
      idOf(1),
      idOf(2),
      idOf(3),
      idOf(4),
      idOf(5),
    ]);
  });

  it('errs with E_CYCLE on cyclic input', () => {
    const cyclic = buildEdgeIndex([
      makeEdge({ id: idOf(210), predecessor_id: idOf(5), successor_id: idOf(6) }),
      makeEdge({ id: idOf(211), predecessor_id: idOf(6), successor_id: idOf(5) }),
    ]);
    const order = topologicalOrder(cyclic, [idOf(5), idOf(6), idOf(7)]);
    expect(!order.ok && order.error.code).toBe('E_CYCLE');
    expect(hasCycle(cyclic, [idOf(5), idOf(6)])).toBe(true);
    expect(hasCycle(edges, taskIds)).toBe(false);
  });
});

describe('property: gated random insertion never admits a cycle (S4 DoD)', () => {
  it('holds for arbitrary insert sequences, with E_CYCLE rejections verified by oracle', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: TASK_COUNT }),
            fc.integer({ min: 1, max: TASK_COUNT }),
          ),
          { maxLength: 120 },
        ),
        (pairs) => {
          const accepted: Edge[] = [];
          let nextEdgeId = 1000;
          for (const [a, b] of pairs) {
            const candidate = { predecessor_id: idOf(a), successor_id: idOf(b) };
            const edgeIndex = buildEdgeIndex(accepted);
            const verdict = validateEdge(tree, edgeIndex, candidate);
            if (verdict.ok) {
              accepted.push(makeEdge({ id: idOf((nextEdgeId += 1)), ...candidate }));
              // the in-variant fact set never contains a cycle
              expect(hasCycle(buildEdgeIndex(accepted), taskIds)).toBe(false);
            } else if (verdict.error.code === 'E_CYCLE') {
              // oracle: force-inserting the rejected edge DOES create a cycle
              const forced = [
                ...accepted,
                makeEdge({ id: idOf(9999), ...candidate }),
              ];
              expect(hasCycle(buildEdgeIndex(forced), taskIds)).toBe(true);
            } else {
              expect(verdict.error.code).toBe('E_DUPLICATE');
            }
          }
          // wouldCreateCycle agrees with a full topological check at the end
          const finalIndex = buildEdgeIndex(accepted);
          for (let a = 1; a <= TASK_COUNT; a += 1) {
            for (let b = 1; b <= TASK_COUNT; b += 1) {
              if (wouldCreateCycle(finalIndex, idOf(a), idOf(b))) {
                const forced = [
                  ...accepted,
                  makeEdge({ id: idOf(9999), predecessor_id: idOf(a), successor_id: idOf(b) }),
                ];
                expect(hasCycle(buildEdgeIndex(forced), taskIds)).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

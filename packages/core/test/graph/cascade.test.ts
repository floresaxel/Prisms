/**
 * S4 DoD: soft-delete cascade golden tests (I10).
 */
import { describe, expect, it } from 'vitest';

import { softDeleteClosure } from '../../src/graph/cascade';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeNode } from '../helpers/fixtures';

const DELETED = '2026-06-02T00:00:00.000Z';

const V = makeNode({ id: idOf(1), node_type: 'vision' });
const R = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: V.id });
const P = makeNode({ id: idOf(3), node_type: 'project', parent_id: R.id });
const M1 = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: P.id, sort_order: 'a0' });
const M2 = makeNode({ id: idOf(5), node_type: 'milestone', parent_id: P.id, sort_order: 'a1' });
const T1 = makeNode({ id: idOf(6), node_type: 'task', parent_id: M1.id, sort_order: 'a0' });
const T2 = makeNode({ id: idOf(7), node_type: 'task', parent_id: M1.id, sort_order: 'a1' });
const T3 = makeNode({ id: idOf(8), node_type: 'task', parent_id: M2.id });

describe('softDeleteClosure (I10)', () => {
  it('marks the full live subtree in deterministic pre-order', () => {
    const index = buildTreeIndex([V, R, P, M1, M2, T1, T2, T3]);
    expect(softDeleteClosure(index, P.id)).toEqual([
      P.id,
      M1.id,
      T1.id,
      T2.id,
      M2.id,
      T3.id,
    ]);
  });

  it('cascades from the very top', () => {
    const index = buildTreeIndex([V, R, P, M1, M2, T1, T2, T3]);
    expect(softDeleteClosure(index, V.id)).toEqual([
      V.id,
      R.id,
      P.id,
      M1.id,
      T1.id,
      T2.id,
      M2.id,
      T3.id,
    ]);
  });

  it('a leaf closure is just the leaf', () => {
    const index = buildTreeIndex([V, R, P, M1, M2, T1, T2, T3]);
    expect(softDeleteClosure(index, T3.id)).toEqual([T3.id]);
  });

  it('skips already-deleted descendants (no rewrite of deleted rows)', () => {
    const index = buildTreeIndex([
      V, R, P, M1, M2,
      { ...T1, deleted_at: DELETED },
      T2,
      T3,
    ]);
    expect(softDeleteClosure(index, M1.id)).toEqual([M1.id, T2.id]);
  });

  it('does not reach live nodes orphaned under a previously deleted ancestor', () => {
    // M1 was already deleted; T1/T2 under it were left live by a divergent
    // device. Deleting P cannot see through the deleted M1 — the earlier
    // cascade (or the server backstop) owns those rows.
    const index = buildTreeIndex([
      V, R, P,
      { ...M1, deleted_at: DELETED },
      M2, T1, T2, T3,
    ]);
    expect(softDeleteClosure(index, P.id)).toEqual([P.id, M2.id, T3.id]);
  });

  it('returns [] for missing or already-deleted roots', () => {
    const index = buildTreeIndex([V, { ...R, deleted_at: DELETED }]);
    expect(softDeleteClosure(index, R.id)).toEqual([]);
    expect(softDeleteClosure(index, idOf(999))).toEqual([]);
  });
});

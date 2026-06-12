import { describe, expect, it } from 'vitest';

import {
  ancestorsOf,
  buildTreeIndex,
  childrenOf,
  descendantsOf,
  getNode,
  subtreeOf,
} from '../../src/graph/tree';
import { idOf, makeNode } from '../helpers/fixtures';

const V = makeNode({ id: idOf(1), node_type: 'vision', sort_order: 'a0' });
const R = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: V.id });
const P = makeNode({ id: idOf(3), node_type: 'project', parent_id: R.id });
const M = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: P.id, sort_order: 'a0' });
const T1 = makeNode({ id: idOf(5), node_type: 'task', parent_id: M.id, sort_order: 'a1' });
const T2 = makeNode({ id: idOf(6), node_type: 'task', parent_id: M.id, sort_order: 'a0' });
const T3 = makeNode({ id: idOf(7), node_type: 'task', parent_id: P.id, sort_order: 'a1' });
const ACT = makeNode({ id: idOf(8), node_type: 'activity', sort_order: 'a1' });

const index = buildTreeIndex([V, R, P, M, T1, T2, T3, ACT]);

describe('buildTreeIndex', () => {
  it('indexes live nodes and drops deleted ones', () => {
    const withDeleted = buildTreeIndex([
      V,
      { ...R, deleted_at: '2026-06-02T00:00:00.000Z' },
    ]);
    expect(getNode(withDeleted, V.id)).toEqual(V);
    expect(getNode(withDeleted, R.id)).toBeUndefined();
    expect(childrenOf(withDeleted, V.id)).toEqual([]);
  });
});

describe('childrenOf', () => {
  it('returns children in (sort_order, id) order', () => {
    expect(childrenOf(index, M.id).map((n) => n.id)).toEqual([T2.id, T1.id]);
  });

  it('breaks equal sort_order ties by id (offline same-key collision)', () => {
    const a = makeNode({ id: idOf(11), node_type: 'task', parent_id: M.id, sort_order: 'a0' });
    const b = makeNode({ id: idOf(10), node_type: 'task', parent_id: M.id, sort_order: 'a0' });
    const collided = buildTreeIndex([M, a, b]);
    expect(childrenOf(collided, M.id).map((n) => n.id)).toEqual([b.id, a.id]);
  });

  it('lists roots under the null parent key', () => {
    expect(childrenOf(index, null).map((n) => n.id)).toEqual([V.id, ACT.id]);
  });

  it('is empty for leaves and unknown ids', () => {
    expect(childrenOf(index, T1.id)).toEqual([]);
    expect(childrenOf(index, idOf(999))).toEqual([]);
  });
});

describe('ancestorsOf', () => {
  it('walks nearest-first up to the root', () => {
    expect(ancestorsOf(index, T1.id).map((n) => n.id)).toEqual([
      M.id,
      P.id,
      R.id,
      V.id,
    ]);
  });

  it('is empty for roots and unknown ids', () => {
    expect(ancestorsOf(index, V.id)).toEqual([]);
    expect(ancestorsOf(index, idOf(999))).toEqual([]);
  });

  it('stops at a dangling parent reference', () => {
    const orphan = makeNode({ id: idOf(20), node_type: 'task', parent_id: idOf(999) });
    const idx = buildTreeIndex([orphan]);
    expect(ancestorsOf(idx, orphan.id)).toEqual([]);
  });

  it('terminates on a corrupt parent loop', () => {
    const a = makeNode({ id: idOf(30), node_type: 'task', parent_id: idOf(31) });
    const b = makeNode({ id: idOf(31), node_type: 'task', parent_id: idOf(30) });
    const idx = buildTreeIndex([a, b]);
    expect(ancestorsOf(idx, a.id).map((n) => n.id)).toEqual([b.id]);
  });
});

describe('subtreeOf / descendantsOf', () => {
  it('returns the subtree in pre-order following sibling order', () => {
    expect(subtreeOf(index, P.id).map((n) => n.id)).toEqual([
      P.id,
      M.id, // sort 'a0' before T3 'a1'
      T2.id, // within M: 'a0' before 'a1'
      T1.id,
      T3.id,
    ]);
  });

  it('descendantsOf excludes the root', () => {
    expect(descendantsOf(index, M.id).map((n) => n.id)).toEqual([T2.id, T1.id]);
  });

  it('is empty for missing or deleted roots', () => {
    expect(subtreeOf(index, idOf(999))).toEqual([]);
    const idx = buildTreeIndex([{ ...P, deleted_at: '2026-06-02T00:00:00.000Z' }, M]);
    expect(subtreeOf(idx, P.id)).toEqual([]);
  });

  it('terminates on corrupt loops', () => {
    const a = makeNode({ id: idOf(30), node_type: 'task', parent_id: idOf(31) });
    const b = makeNode({ id: idOf(31), node_type: 'task', parent_id: idOf(30) });
    const idx = buildTreeIndex([a, b]);
    expect(subtreeOf(idx, a.id).map((n) => n.id)).toEqual([a.id, b.id]);
  });
});

/**
 * S4 DoD: I1 matrix test — every parent/child type pair — plus the I2
 * vision limit.
 */
import { describe, expect, it } from 'vitest';

import { NODE_TYPES, type NodeType } from '../../src/domain/entities';
import {
  countVisions,
  MAX_VISIONS,
  validateNodeMove,
  validateNodeParent,
  validateVisionLimit,
} from '../../src/graph/hierarchy';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeNode } from '../helpers/fixtures';

// One potential parent of every type.
const parentOf: Record<NodeType, ReturnType<typeof makeNode>> = {
  vision: makeNode({ id: idOf(1), node_type: 'vision' }),
  roadmap: makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: idOf(1) }),
  project: makeNode({ id: idOf(3), node_type: 'project', parent_id: idOf(2) }),
  milestone: makeNode({ id: idOf(4), node_type: 'milestone', parent_id: idOf(3) }),
  task: makeNode({ id: idOf(5), node_type: 'task', parent_id: idOf(4) }),
  activity: makeNode({ id: idOf(6), node_type: 'activity' }),
};
const index = buildTreeIndex(Object.values(parentOf));

/** The I1 matrix exactly as specified in §6.7. */
const SPEC_ALLOWED: Record<NodeType, readonly NodeType[]> = {
  vision: [],
  roadmap: ['vision'],
  project: ['roadmap'],
  milestone: ['project'],
  task: ['milestone', 'project'],
  activity: [],
};
const SPEC_PARENTLESS: Record<NodeType, boolean> = {
  vision: true,
  roadmap: false,
  project: false,
  milestone: false,
  task: true, // habit-spawned; I3 enforces the xor
  activity: true,
};

describe('I1 matrix — every (child, parent) type pair', () => {
  for (const child of NODE_TYPES) {
    for (const parent of NODE_TYPES) {
      const allowed = SPEC_ALLOWED[child].includes(parent);
      it(`${child} under ${parent}: ${allowed ? 'allowed' : 'E_HIERARCHY'}`, () => {
        const verdict = validateNodeParent(index, child, parentOf[parent].id);
        expect(verdict.ok).toBe(allowed);
        if (!verdict.ok) expect(verdict.error.code).toBe('E_HIERARCHY');
      });
    }
    it(`${child} with no parent: ${SPEC_PARENTLESS[child] ? 'allowed' : 'E_HIERARCHY'}`, () => {
      const verdict = validateNodeParent(index, child, null);
      expect(verdict.ok).toBe(SPEC_PARENTLESS[child]);
      if (!verdict.ok) expect(verdict.error.code).toBe('E_HIERARCHY');
    });
  }

  it('missing parent id is E_NOT_FOUND', () => {
    const verdict = validateNodeParent(index, 'task', idOf(999));
    expect(!verdict.ok && verdict.error.code).toBe('E_NOT_FOUND');
  });
});

describe('validateNodeMove (node.move re-validates I1)', () => {
  // V ← R ← P ← M ← T plus a second project P2 under R.
  const V = makeNode({ id: idOf(1), node_type: 'vision' });
  const R = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: V.id });
  const P = makeNode({ id: idOf(3), node_type: 'project', parent_id: R.id });
  const M = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: P.id });
  const T = makeNode({ id: idOf(5), node_type: 'task', parent_id: M.id });
  const P2 = makeNode({ id: idOf(7), node_type: 'project', parent_id: R.id, sort_order: 'a1' });
  const idx = buildTreeIndex([V, R, P, M, T, P2]);

  it('allows a legal re-parent (task milestone → project)', () => {
    expect(validateNodeMove(idx, T.id, P2.id).ok).toBe(true);
  });

  it('rejects typing violations on the new parent', () => {
    const verdict = validateNodeMove(idx, M.id, R.id);
    expect(!verdict.ok && verdict.error.code).toBe('E_HIERARCHY');
  });

  it('rejects self-parenting', () => {
    const verdict = validateNodeMove(idx, P.id, P.id);
    expect(!verdict.ok && verdict.error.code).toBe('E_HIERARCHY');
  });

  it('rejects moving a node under its own descendant', () => {
    const verdict = validateNodeMove(idx, P.id, M.id);
    expect(!verdict.ok && verdict.error.code).toBe('E_HIERARCHY');
  });

  it('rejects moving a missing node', () => {
    const verdict = validateNodeMove(idx, idOf(999), P.id);
    expect(!verdict.ok && verdict.error.code).toBe('E_NOT_FOUND');
  });
});

describe('I2 — max 4 visions', () => {
  const visions = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeNode({ id: idOf(100 + i), node_type: 'vision', sort_order: `a${i}` }),
    );

  it('allows creating up to the limit', () => {
    expect(countVisions(buildTreeIndex(visions(3)))).toBe(3);
    expect(validateVisionLimit(buildTreeIndex(visions(3))).ok).toBe(true);
  });

  it('rejects a fifth vision with E_MAX_VISIONS', () => {
    const verdict = validateVisionLimit(buildTreeIndex(visions(MAX_VISIONS)));
    expect(!verdict.ok && verdict.error.code).toBe('E_MAX_VISIONS');
  });

  it('ignores soft-deleted visions', () => {
    const four = visions(MAX_VISIONS);
    (four[0] as { deleted_at: string | null }).deleted_at = '2026-06-02T00:00:00.000Z';
    const idx = buildTreeIndex(four);
    expect(countVisions(idx)).toBe(3);
    expect(validateVisionLimit(idx).ok).toBe(true);
  });
});

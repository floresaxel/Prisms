/**
 * S4 DoD: justification golden tests (I3 + the §12.2 isJustified render check).
 */
import { describe, expect, it } from 'vitest';

import { isJustified, validateTaskJustification } from '../../src/graph/justify';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeNode } from '../helpers/fixtures';

// Healthy chain: V ← R ← P ← M ← T1, plus T2 directly under P.
const V = makeNode({ id: idOf(1), node_type: 'vision' });
const R = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: V.id });
const P = makeNode({ id: idOf(3), node_type: 'project', parent_id: R.id });
const M = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: P.id });
const T1 = makeNode({ id: idOf(5), node_type: 'task', parent_id: M.id });
const T2 = makeNode({ id: idOf(6), node_type: 'task', parent_id: P.id, sort_order: 'a1' });
// Orphan subtree (project detached from any vision): OP ← OM ← T3.
const OP = makeNode({ id: idOf(7), node_type: 'project', sort_order: 'a2' });
const OM = makeNode({ id: idOf(8), node_type: 'milestone', parent_id: OP.id });
const T3 = makeNode({ id: idOf(9), node_type: 'task', parent_id: OM.id });
// Habit-spawned task and an inbox activity.
const HABIT_ID = idOf(50);
const HT = makeNode({ id: idOf(10), node_type: 'task', habit_id: HABIT_ID, sort_order: 'a3' });
const ACT = makeNode({ id: idOf(11), node_type: 'activity', sort_order: 'a4' });

const index = buildTreeIndex([V, R, P, M, T1, T2, OP, OM, T3, HT, ACT]);

describe('isJustified (§12.2 — grey calendar rule)', () => {
  it('tasks whose ancestry reaches a vision are justified', () => {
    expect(isJustified(index, T1.id)).toBe(true);
    expect(isJustified(index, T2.id)).toBe(true);
  });

  it('tasks under a vision-less project render grey', () => {
    expect(isJustified(index, T3.id)).toBe(false);
    expect(isJustified(index, OP.id)).toBe(false);
  });

  it('habit-linked tasks are justified without ancestry', () => {
    expect(isJustified(index, HT.id)).toBe(true);
  });

  it('inbox activities are unjustified until promoted', () => {
    expect(isJustified(index, ACT.id)).toBe(false);
  });

  it('visions and intermediate nodes on a vision chain are justified', () => {
    expect(isJustified(index, V.id)).toBe(true);
    expect(isJustified(index, R.id)).toBe(true);
    expect(isJustified(index, M.id)).toBe(true);
  });

  it('a soft-deleted ancestor breaks the chain', () => {
    const broken = buildTreeIndex([
      V,
      R,
      P,
      { ...M, deleted_at: '2026-06-02T00:00:00.000Z' },
      T1,
    ]);
    expect(isJustified(broken, T1.id)).toBe(false);
  });

  it('unknown nodes are not justified', () => {
    expect(isJustified(index, idOf(999))).toBe(false);
  });
});

describe('validateTaskJustification (I3 — ancestor project xor habit_id)', () => {
  it('accepts a task under a milestone (reaches a project)', () => {
    expect(
      validateTaskJustification(index, {
        node_type: 'task',
        parent_id: M.id,
        habit_id: null,
      }).ok,
    ).toBe(true);
  });

  it('accepts a task directly under a project', () => {
    expect(
      validateTaskJustification(index, {
        node_type: 'task',
        parent_id: P.id,
        habit_id: null,
      }).ok,
    ).toBe(true);
  });

  it('accepts a parentless habit task', () => {
    expect(
      validateTaskJustification(index, {
        node_type: 'task',
        parent_id: null,
        habit_id: HABIT_ID,
      }).ok,
    ).toBe(true);
  });

  it('I3 is satisfied by a vision-less project chain (render-grey is a separate concern)', () => {
    expect(
      validateTaskJustification(index, {
        node_type: 'task',
        parent_id: OM.id,
        habit_id: null,
      }).ok,
    ).toBe(true);
  });

  it('rejects both justifications at once', () => {
    const verdict = validateTaskJustification(index, {
      node_type: 'task',
      parent_id: M.id,
      habit_id: HABIT_ID,
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_JUSTIFICATION');
  });

  it('rejects no justification at all', () => {
    const verdict = validateTaskJustification(index, {
      node_type: 'task',
      parent_id: null,
      habit_id: null,
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_JUSTIFICATION');
  });

  it('rejects a parent chain that reaches no project', () => {
    const verdict = validateTaskJustification(index, {
      node_type: 'task',
      parent_id: R.id, // roadmap chain reaches a vision but no project
      habit_id: null,
    });
    expect(!verdict.ok && verdict.error.code).toBe('E_JUSTIFICATION');
  });

  it('exempts activities until promoted, and ignores non-tasks', () => {
    expect(
      validateTaskJustification(index, {
        node_type: 'activity',
        parent_id: null,
        habit_id: null,
      }).ok,
    ).toBe(true);
    expect(
      validateTaskJustification(index, {
        node_type: 'milestone',
        parent_id: P.id,
        habit_id: null,
      }).ok,
    ).toBe(true);
  });
});

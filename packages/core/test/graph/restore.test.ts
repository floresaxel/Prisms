/**
 * node.restore — the inverse of the I10 soft-delete cascade: `restoreClosure`
 * brings back the root and only what its OWN cascade deleted (same stamp), and
 * `checkNodeRestore` requires a live parent and keeps I2.
 */
import { describe, expect, it } from 'vitest';

import { buildTreeIndex, checkNodeRestore, MAX_VISIONS, restoreClosure } from '../../src/index';
import { idOf, makeNode } from '../helpers/fixtures';

const T1 = '2026-11-20T10:00:00.000Z';
const T0 = '2026-11-19T09:00:00.000Z';

function world() {
  const vision = makeNode({ id: idOf(1), node_type: 'vision' });
  const roadmap = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: vision.id });
  // the project and both tasks went in ONE cascade (T1); task C was deleted alone the day before (T0)
  const project = makeNode({ id: idOf(3), node_type: 'project', parent_id: roadmap.id, deleted_at: T1 });
  const taskA = makeNode({ id: idOf(4), node_type: 'task', parent_id: project.id, sort_order: 'a0', deleted_at: T1 });
  const taskB = makeNode({ id: idOf(5), node_type: 'task', parent_id: project.id, sort_order: 'a1', deleted_at: T1 });
  const taskC = makeNode({ id: idOf(6), node_type: 'task', parent_id: project.id, sort_order: 'a2', deleted_at: T0 });
  const rows = [vision, roadmap, project, taskA, taskB, taskC];
  return { vision, roadmap, project, taskA, taskB, taskC, rows, tree: buildTreeIndex(rows) };
}

describe('restoreClosure', () => {
  it('returns the root plus the descendants its cascade deleted, in pre-order', () => {
    const { project, taskA, taskB, rows } = world();
    expect(restoreClosure(rows, project.id)).toEqual([project.id, taskA.id, taskB.id]);
  });

  it('leaves a child that was deleted on its own (a different stamp) deleted', () => {
    const { project, taskC, rows } = world();
    expect(restoreClosure(rows, project.id)).not.toContain(taskC.id);
  });

  it('is empty for a live or missing root', () => {
    const { roadmap, rows } = world();
    expect(restoreClosure(rows, roadmap.id)).toEqual([]);
    expect(restoreClosure(rows, idOf(99))).toEqual([]);
  });
});

describe('checkNodeRestore', () => {
  it('accepts a deleted node under a live parent, and a live node as a no-op', () => {
    const { project, roadmap, tree } = world();
    expect(checkNodeRestore(tree, project.id, project).ok).toBe(true);
    expect(checkNodeRestore(tree, roadmap.id, roadmap).ok).toBe(true);
  });

  it('rejects a node whose parent is still deleted (restore the parent first)', () => {
    const { taskA, tree } = world();
    const r = checkNodeRestore(tree, taskA.id, taskA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_HIERARCHY');
  });

  it('rejects a missing node', () => {
    const { tree } = world();
    const r = checkNodeRestore(tree, idOf(99), undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_NOT_FOUND');
  });

  it('keeps the vision limit (I2): a deleted vision cannot come back over the cap', () => {
    const live = Array.from({ length: MAX_VISIONS }, (_, i) => makeNode({ id: idOf(10 + i), node_type: 'vision' }));
    const gone = makeNode({ id: idOf(50), node_type: 'vision', deleted_at: T1 });
    const r = checkNodeRestore(buildTreeIndex([...live, gone]), gone.id, gone);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_MAX_VISIONS');
  });
});

/**
 * Phase 2: project completion % treats an obsolete task as descoped — it leaves
 * the denominator entirely (§7.2), so it neither counts as done nor drags the
 * project toward looking incomplete.
 */
import { describe, expect, it } from 'vitest';

import { canonicalCompletion } from '../../src/aggregates/completion';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeNode } from '../helpers/fixtures';

const DONE_AT = '2026-06-13T00:00:00.000Z';
const PROJECT = idOf(1);

function tree(tasks: ReturnType<typeof makeNode>[]) {
  return buildTreeIndex([makeNode({ id: PROJECT, node_type: 'project' }), ...tasks]);
}
const task = (n: number, over: Partial<ReturnType<typeof makeNode>> = {}) =>
  makeNode({ id: idOf(n), node_type: 'task', parent_id: PROJECT, estimate_minutes: 60, ...over });

describe('project completion % with obsolete disposition', () => {
  it('excludes obsolete tasks from the denominator', () => {
    const c = canonicalCompletion(
      PROJECT,
      tree([
        task(2, { completed_at: DONE_AT, completion_disposition: 'completed' }),
        task(3, { completed_at: DONE_AT, completion_disposition: 'obsolete' }),
        task(4), // pending
      ]),
    );
    // obsolete (id 3) is descoped: 1 done of 2 in-scope tasks (60/120) = 50%
    expect(c.totalWeight).toBe(120);
    expect(c.completedWeight).toBe(60);
    expect(c.percent).toBe(50);
  });

  it('an all-obsolete project reads 0/0 → 0%', () => {
    const c = canonicalCompletion(
      PROJECT,
      tree([
        task(2, { completed_at: DONE_AT, completion_disposition: 'obsolete' }),
        task(3, { completed_at: DONE_AT, completion_disposition: 'obsolete' }),
      ]),
    );
    expect(c.totalWeight).toBe(0);
    expect(c.percent).toBe(0);
  });

  it('a plain completed task (no disposition / legacy null) still counts', () => {
    const c = canonicalCompletion(PROJECT, tree([task(2, { completed_at: DONE_AT })]));
    expect(c.completedWeight).toBe(60);
    expect(c.percent).toBe(100);
  });
});

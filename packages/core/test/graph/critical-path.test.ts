import { describe, expect, it } from 'vitest';

import { criticalPath } from '../../src/graph/critical-path';
import { idOf, makeEdge, makeNode } from '../helpers/fixtures';

const task = (n: number, estimate: number | null) =>
  makeNode({ id: idOf(n), node_type: 'task', estimate_minutes: estimate });

describe('criticalPath (§12.2 — longest path by estimates)', () => {
  it('returns the empty path for no tasks', () => {
    expect(criticalPath([], [])).toEqual({
      ok: true,
      value: { totalMinutes: 0, nodeIds: [] },
    });
  });

  it('sums a simple chain', () => {
    const tasks = [task(1, 60), task(2, 30), task(3, 10)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(2), successor_id: idOf(3) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 100,
      nodeIds: [idOf(1), idOf(2), idOf(3)],
    });
  });

  it('picks the longest branch of a diamond', () => {
    const tasks = [task(1, 10), task(2, 50), task(3, 20), task(4, 10)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(1), successor_id: idOf(3) }),
      makeEdge({ id: idOf(102), predecessor_id: idOf(2), successor_id: idOf(4) }),
      makeEdge({ id: idOf(103), predecessor_id: idOf(3), successor_id: idOf(4) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 70,
      nodeIds: [idOf(1), idOf(2), idOf(4)],
    });
  });

  it('positive lag lengthens a path enough to win', () => {
    const tasks = [task(1, 10), task(2, 20), task(3, 20), task(4, 10)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(1), successor_id: idOf(3) }),
      // equal estimates on both branches; the 90-minute lag decides it
      makeEdge({ id: idOf(102), predecessor_id: idOf(2), successor_id: idOf(4), lag_minutes: 90 }),
      makeEdge({ id: idOf(103), predecessor_id: idOf(3), successor_id: idOf(4) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 130,
      nodeIds: [idOf(1), idOf(2), idOf(4)],
    });
  });

  it('negative lag (lead) shortens a branch', () => {
    const tasks = [task(1, 10), task(2, 50), task(3, 45), task(4, 10)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(1), successor_id: idOf(3) }),
      makeEdge({ id: idOf(102), predecessor_id: idOf(2), successor_id: idOf(4), lag_minutes: -20 }),
      makeEdge({ id: idOf(103), predecessor_id: idOf(3), successor_id: idOf(4) }),
    ];
    const result = criticalPath(tasks, edges);
    // via 2: 10+50-20+10 = 50; via 3: 10+45+0+10 = 65
    expect(result.ok && result.value).toEqual({
      totalMinutes: 65,
      nodeIds: [idOf(1), idOf(3), idOf(4)],
    });
  });

  it('breaks exact ties toward the smaller node id (deterministic everywhere)', () => {
    const tasks = [task(1, 10), task(2, 20), task(3, 20), task(4, 10)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(1), successor_id: idOf(3) }),
      makeEdge({ id: idOf(102), predecessor_id: idOf(2), successor_id: idOf(4) }),
      makeEdge({ id: idOf(103), predecessor_id: idOf(3), successor_id: idOf(4) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 40,
      nodeIds: [idOf(1), idOf(2), idOf(4)], // idOf(2) < idOf(3)
    });
  });

  it('an isolated heavyweight can be the critical path', () => {
    const tasks = [task(1, 30), task(2, 30), task(3, 100)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 100,
      nodeIds: [idOf(3)],
    });
  });

  it('treats missing estimates as zero', () => {
    const tasks = [task(1, null), task(2, 40)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 40,
      nodeIds: [idOf(1), idOf(2)],
    });
  });

  it('ignores deleted tasks and edges referencing outside nodes', () => {
    const gone = { ...task(3, 500), deleted_at: '2026-06-02T00:00:00.000Z' };
    const tasks = [task(1, 10), task(2, 20), gone];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(3), successor_id: idOf(2) }),
      makeEdge({ id: idOf(102), predecessor_id: idOf(1), successor_id: idOf(999) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(result.ok && result.value).toEqual({
      totalMinutes: 30,
      nodeIds: [idOf(1), idOf(2)],
    });
  });

  it('errs with E_CYCLE on cyclic input rather than guessing', () => {
    const tasks = [task(1, 10), task(2, 20)];
    const edges = [
      makeEdge({ id: idOf(100), predecessor_id: idOf(1), successor_id: idOf(2) }),
      makeEdge({ id: idOf(101), predecessor_id: idOf(2), successor_id: idOf(1) }),
    ];
    const result = criticalPath(tasks, edges);
    expect(!result.ok && result.error.code).toBe('E_CYCLE');
  });
});

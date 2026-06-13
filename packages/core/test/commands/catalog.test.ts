/**
 * S11 core DoD: the §8.1 catalog schemas are strict (a full-row write is
 * impossible by construction), and one rejecting case per §6.7 invariant via
 * the pure check* functions the client and server both run.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_NAMES,
  COMMAND_SCHEMAS,
  checkActivityPromote,
  checkBlockCreate,
  checkBlockMove,
  checkClockIn,
  checkClockOut,
  checkEdgeCreate,
  checkHabitVision,
  checkNodeCreate,
  checkNodeMove,
  checkNodeRetype,
  checkRule,
  isCommandName,
  softDeleteClosure,
} from '../../src/index';
import { buildEdgeIndex } from '../../src/graph/dag';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeEdge, makeNode } from '../helpers/fixtures';

describe('catalog completeness + strictness (DoD schema test)', () => {
  it('registers all 49 §8.1 verbs and resolves names', () => {
    expect(COMMAND_NAMES.length).toBe(49);
    expect(isCommandName('node.create')).toBe(true);
    expect(isCommandName('node.update')).toBe(false); // no generic update endpoint
  });

  it('rejects any field the verb does not name — no full-row write', () => {
    // node.rename names only {id, title}; smuggling other columns is rejected
    const id = idOf(1);
    expect(COMMAND_SCHEMAS['node.rename'].safeParse({ id, title: 'ok' }).success).toBe(true);
    for (const sneaky of [
      { id, title: 'x', user_id: idOf(9) },
      { id, title: 'x', completed_at: '2026-06-13T00:00:00.000Z' },
      { id, title: 'x', node_type: 'vision' },
      { id, title: 'x', deleted_at: null },
    ]) {
      expect(COMMAND_SCHEMAS['node.rename'].safeParse(sneaky).success).toBe(false);
    }
    // node.create cannot set the completion FACT or audit columns
    const base = { id, node_type: 'task', title: 't', sort_order: 'a0', parent_id: idOf(2) };
    expect(COMMAND_SCHEMAS['node.create'].safeParse({ ...base, completed_at: '2026-06-13T00:00:00.000Z' }).success).toBe(false);
    expect(COMMAND_SCHEMAS['node.create'].safeParse({ ...base, user_id: idOf(9) }).success).toBe(false);
  });

  it('every schema is a strict object (rejects an extra unknown key)', () => {
    for (const name of COMMAND_NAMES) {
      const schema = COMMAND_SCHEMAS[name];
      // a payload that is only an unknown key must never parse
      expect(schema.safeParse({ __sneaky__: true }).success, `${name} accepted junk`).toBe(false);
    }
  });
});

// vision → roadmap → project → milestone → task world
function world() {
  const vision = makeNode({ id: idOf(1), node_type: 'vision' });
  const roadmap = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: vision.id });
  const project = makeNode({ id: idOf(3), node_type: 'project', parent_id: roadmap.id });
  const milestone = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: project.id });
  const task = makeNode({ id: idOf(5), node_type: 'task', parent_id: milestone.id });
  const nodes = [vision, roadmap, project, milestone, task];
  return { vision, roadmap, project, milestone, task, tree: buildTreeIndex(nodes), nodes };
}

describe('invariant rejections — one per §6.7 invariant', () => {
  it('I1 hierarchy typing: a task cannot be a child of a vision', () => {
    const { vision, tree } = world();
    const r = checkNodeCreate(tree, { node_type: 'task', parent_id: vision.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_HIERARCHY');
    // a parentless roadmap is also rejected
    expect(checkNodeCreate(tree, { node_type: 'roadmap', parent_id: null }).ok).toBe(false);
  });

  it('I2 max visions: a 5th vision is rejected', () => {
    const visions = [0, 1, 2, 3].map((i) => makeNode({ id: idOf(10 + i), node_type: 'vision' }));
    const r = checkNodeCreate(buildTreeIndex(visions), { node_type: 'vision', parent_id: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_MAX_VISIONS');
  });

  it('I3 justification: a task with neither an ancestor project nor a habit_id', () => {
    const { tree } = world();
    const orphan = checkNodeCreate(tree, { node_type: 'task', parent_id: null, habit_id: null });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.error.code).toBe('E_JUSTIFICATION');
    // …and both at once is also rejected (xor)
    const { project } = world();
    const both = checkNodeCreate(tree, { node_type: 'task', parent_id: project.id, habit_id: idOf(99) });
    expect(both.ok).toBe(false);
  });

  it('I4 DAG + same-type: type mismatch and cycle are rejected', () => {
    const { task, project, tree } = world();
    const noEdges = buildEdgeIndex([]);
    const mismatch = checkEdgeCreate(tree, noEdges, { predecessor_id: task.id, successor_id: project.id });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('E_EDGE_TYPE_MISMATCH');

    // two sibling tasks with an edge a→b; adding b→a would cycle
    const a = makeNode({ id: idOf(20), node_type: 'task', parent_id: project.id });
    const b = makeNode({ id: idOf(21), node_type: 'task', parent_id: project.id });
    const tree2 = buildTreeIndex([project, a, b]);
    const edges = buildEdgeIndex([makeEdge({ id: idOf(30), predecessor_id: a.id, successor_id: b.id })]);
    const cycle = checkEdgeCreate(tree2, edges, { predecessor_id: b.id, successor_id: a.id });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.code).toBe('E_CYCLE');
  });

  it('I5 one open timer: a second clock-in while one runs is rejected', () => {
    const { task } = world();
    const r = checkClockIn(task, task.id, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_TIMER_ALREADY_RUNNING');
  });

  it('I6 interval: a block (and an entry) that ends before it starts', () => {
    const { task } = world();
    const block = checkBlockCreate(task, task.id, {
      starts_at: '2026-06-13T11:00:00.000Z',
      ends_at: '2026-06-13T10:00:00.000Z',
    });
    expect(block.ok).toBe(false);
    if (!block.ok) expect(block.error.code).toBe('E_INVALID_INTERVAL');
    const entry = checkClockOut(
      { started_at: '2026-06-13T11:00:00.000Z', ended_at: null },
      idOf(40),
      { ended_at: '2026-06-13T10:00:00.000Z' },
    );
    expect(entry.ok).toBe(false);
  });

  it('I7 anchored immutable: moving an anchored block is rejected', () => {
    const { task } = world();
    const r = checkBlockMove({ anchor_type: 'both', task_id: task.id }, idOf(50), task, {
      starts_at: '2026-06-13T10:00:00.000Z',
      ends_at: '2026-06-13T11:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_ANCHORED_IMMUTABLE');
  });

  it('I8 done immutable: scheduling or clocking into a done task is rejected', () => {
    const done = makeNode({ id: idOf(5), node_type: 'task', completed_at: '2026-06-12T00:00:00.000Z' });
    const block = checkBlockCreate(done, done.id, {
      starts_at: '2026-06-13T10:00:00.000Z',
      ends_at: '2026-06-13T11:00:00.000Z',
    });
    expect(block.ok).toBe(false);
    if (!block.ok) expect(block.error.code).toBe('E_DONE_IMMUTABLE');
    expect(checkClockIn(done, done.id, false).ok).toBe(false);
  });

  it('I10 cascade: soft-delete closure returns the root plus its live subtree', () => {
    const { project, tree } = world();
    const closure = softDeleteClosure(tree, project.id);
    // project + milestone + task
    expect(closure).toContain(project.id);
    expect(closure).toHaveLength(3);
  });
});

describe('node.move revalidates I1/I3 (DoD)', () => {
  it('rejects moving a task under a vision (I1) and accepts a valid re-parent', () => {
    const { task, vision, project, tree } = world();
    const toVision = checkNodeMove(tree, { id: task.id, new_parent_id: vision.id });
    expect(toVision.ok).toBe(false);
    if (!toVision.ok) expect(toVision.error.code).toBe('E_HIERARCHY');
    expect(checkNodeMove(tree, { id: task.id, new_parent_id: project.id }).ok).toBe(true);
  });

  it('rejects re-parenting that strips a task of justification (I3)', () => {
    // a habit-linked task moved under a project would then have BOTH (I3 xor)
    const project = makeNode({ id: idOf(3), node_type: 'project' });
    const habitTask = makeNode({ id: idOf(6), node_type: 'task', parent_id: null, habit_id: idOf(80) });
    const tree = buildTreeIndex([project, habitTask]);
    const r = checkNodeMove(tree, { id: habitTask.id, new_parent_id: project.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_JUSTIFICATION');
  });
});

describe('other command-time checks', () => {
  it('node.retype revalidates I1 against parent and children', () => {
    const { project, tree } = world();
    // demoting the project to a milestone would orphan its milestone child
    const r = checkNodeRetype(tree, { id: project.id, node_type: 'milestone' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_HIERARCHY');
  });

  it('activity.promote requires a valid justification', () => {
    const activity = makeNode({ id: idOf(7), node_type: 'activity' });
    const tree = buildTreeIndex([activity]);
    // promote with neither parent nor habit ⇒ unjustified task
    const r = checkActivityPromote(tree, { id: activity.id });
    expect(r.ok).toBe(false);
  });

  it('habit must reference a vision', () => {
    const { roadmap, tree } = world();
    const r = checkHabitVision(tree, roadmap.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_HIERARCHY');
  });

  it('rule.create rejects a self-triggering rule (E_RULE_SELF_TRIGGER)', () => {
    const r = checkRule(
      {
        trigger: 'task_created',
        conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^todo' }] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: 'todo follow-up' } }],
      },
      [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_RULE_SELF_TRIGGER');
  });
});

/**
 * M2 — incremental StatusIndex (1.3 §7.12). The index must equal a full rebuild
 * (`taskStatus` over a fresh FactContext) over any effect stream, and recompute
 * only the affected nodes per command.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildFactContext, type FactRows } from '../../src/status/context';
import { StatusIndex, type StatusEffect } from '../../src/status/status-index';
import { taskStatus, type TaskStatus } from '../../src/status/status';
import type { Edge, Node, ScheduleBlock, SprintMembership, TimeEntry } from '../../src/domain/entities';
import { isoToEpochMillis, type Instant } from '../../src/time/instant';
import { idOf, makeBlock, makeBlockerRule, makeEdge, makeEntry, makeMembership, makeNode, makeSprint } from '../helpers/fixtures';

const NOW: Instant = isoToEpochMillis('2026-06-15T12:00:00.000Z');
const SETTINGS = { day_reset_hour: 4, timezone: 'UTC' };
const future = '2026-06-15T18:00:00.000Z';
const past = '2026-06-15T08:00:00.000Z';

/** A vision→project→N task world, plus an active sprint covering NOW. */
function world(taskCount: number) {
  const vision = makeNode({ id: idOf(1), node_type: 'vision' });
  const project = makeNode({ id: idOf(2), node_type: 'project', parent_id: vision.id });
  const tasks = Array.from({ length: taskCount }, (_, i) =>
    makeNode({ id: idOf(100 + i), node_type: 'task', parent_id: project.id, title: `t${i}` }),
  );
  const sprint = makeSprint({ id: idOf(3), starts_on: '2026-06-01', ends_on: '2026-06-30' });
  return {
    nodes: [vision, project, ...tasks] as Node[],
    edges: [] as Edge[],
    time_entries: [] as TimeEntry[],
    schedule_blocks: [] as ScheduleBlock[],
    sprints: [sprint],
    sprint_memberships: [] as SprintMembership[],
    blocker_rules: [] as ReturnType<typeof makeBlockerRule>[],
    project,
    tasks,
    sprint,
  };
}

type World = ReturnType<typeof world>;
const factRows = (w: World): FactRows => ({
  nodes: w.nodes,
  edges: w.edges,
  time_entries: w.time_entries,
  schedule_blocks: w.schedule_blocks,
  sprints: w.sprints,
  sprint_memberships: w.sprint_memberships,
  blocker_rules: w.blocker_rules,
  user_settings: SETTINGS,
});

/** Full-rebuild reference: taskStatus over a fresh FactContext for every task. */
function fullStatuses(w: World): Map<string, TaskStatus> {
  const ctx = buildFactContext(factRows(w));
  const out = new Map<string, TaskStatus>();
  for (const n of w.nodes) if (n.node_type === 'task' && n.deleted_at === null) out.set(n.id, taskStatus(n, ctx, NOW));
  return out;
}

function expectMatchesFull(index: StatusIndex, w: World): void {
  const full = fullStatuses(w);
  for (const [id, status] of full) expect(index.statusOf(id), `task ${id}`).toBe(status);
  expect([...index.allStatuses().keys()].sort()).toEqual([...full.keys()].sort());
}

describe('StatusIndex — initial build matches taskStatus', () => {
  it('reflects every status class from a fresh build', () => {
    const w = world(5);
    // t0 done, t1 ongoing, t2 scheduled, t3 prioritized(sprint), t4 available
    w.tasks[0]!.completed_at = past;
    w.time_entries.push(makeEntry({ id: idOf(200), task_id: w.tasks[1]!.id, started_at: past }));
    w.schedule_blocks.push(makeBlock({ id: idOf(300), task_id: w.tasks[2]!.id, starts_at: past, ends_at: future }));
    w.sprint_memberships.push(makeMembership({ id: idOf(400), sprint_id: w.sprint.id, node_id: w.tasks[3]!.id }));
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('done');
    expect(index.statusOf(w.tasks[1]!.id)).toBe('ongoing');
    expect(index.statusOf(w.tasks[2]!.id)).toBe('scheduled');
    expect(index.statusOf(w.tasks[3]!.id)).toBe('prioritized');
    expect(index.statusOf(w.tasks[4]!.id)).toBe('available');
    expectMatchesFull(index, w);
  });
});

describe('StatusIndex — transitions + locality (instrumented)', () => {
  it('check_off makes the task done and unblocks its FS successor — touching only those two', () => {
    const w = world(10);
    w.edges.push(makeEdge({ id: idOf(500), predecessor_id: w.tasks[0]!.id, successor_id: w.tasks[1]!.id }));
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    expect(index.statusOf(w.tasks[1]!.id)).toBe('blocked'); // FS pred not done

    w.tasks[0]!.completed_at = past;
    const res = index.apply([{ table: 'nodes', op: 'update', row_id: w.tasks[0]!.id, fields: { completed_at: past } }]);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('done');
    expect(index.statusOf(w.tasks[1]!.id)).toBe('available'); // unblocked, no rule fired
    // locality: only the predecessor + successor were recomputed, not all 10 tasks
    expect(res.recomputed.sort()).toEqual([w.tasks[0]!.id, w.tasks[1]!.id].sort());
    expectMatchesFull(index, w);
  });

  it('clock_in makes a task ongoing, touching only that task (no successors)', () => {
    const w = world(20);
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    w.time_entries.push(makeEntry({ id: idOf(600), task_id: w.tasks[5]!.id, started_at: past }));
    const res = index.apply([{ table: 'time_entries', op: 'insert', row_id: idOf(600), fields: { task_id: w.tasks[5]!.id, started_at: past, ended_at: null } }]);
    expect(index.statusOf(w.tasks[5]!.id)).toBe('ongoing');
    expect(res.recomputed).toEqual([w.tasks[5]!.id]); // exactly one node touched
    expectMatchesFull(index, w);
  });

  it('a committed block makes a task scheduled; deleting it reverts', () => {
    const w = world(4);
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    w.schedule_blocks.push(makeBlock({ id: idOf(700), task_id: w.tasks[0]!.id, starts_at: past, ends_at: future }));
    index.apply([{ table: 'schedule_blocks', op: 'insert', row_id: idOf(700), fields: { task_id: w.tasks[0]!.id, starts_at: past, ends_at: future, status: 'committed' } }]);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('scheduled');
    w.schedule_blocks.length = 0;
    index.apply([{ table: 'schedule_blocks', op: 'delete', row_id: idOf(700), fields: {} }]);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('available');
    expectMatchesFull(index, w);
  });

  it('sprint membership makes a task (and its descendants) prioritized', () => {
    const w = world(3);
    // make t0 a parent milestone-ish via a child task to test descendant inheritance
    const child = makeNode({ id: idOf(900), node_type: 'task', parent_id: w.project.id, title: 'child' });
    w.nodes.push(child);
    w.tasks.push(child);
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    w.sprint_memberships.push(makeMembership({ id: idOf(800), sprint_id: w.sprint.id, node_id: w.project.id }));
    index.apply([{ table: 'sprint_memberships', op: 'insert', row_id: idOf(800), fields: { sprint_id: w.sprint.id, node_id: w.project.id } }]);
    // every task under the project inherits the sprint → prioritized
    for (const t of w.tasks) expect(index.statusOf(t.id)).toBe('prioritized');
    expectMatchesFull(index, w);
  });

  it('a blocker rule blocks matching tasks; project.phase blockers stay correct', () => {
    const w = world(2);
    // block any task whose ancestor project is not yet executing (project.phase)
    w.blocker_rules.push(
      makeBlockerRule({ id: idOf(950), predicate: { all: [{ fact: 'project.phase', op: 'eq', value: 'idle' }] } }),
    );
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('blocked'); // project idle
    expect(index.statusOf(w.tasks[1]!.id)).toBe('blocked');

    // completing t0 makes the project 'executing' → both tasks' blocker clears
    w.tasks[0]!.completed_at = past;
    index.apply([{ table: 'nodes', op: 'update', row_id: w.tasks[0]!.id, fields: { completed_at: past } }]);
    expect(index.statusOf(w.tasks[0]!.id)).toBe('done');
    expect(index.statusOf(w.tasks[1]!.id)).toBe('available'); // project no longer idle
    expectMatchesFull(index, w);
  });
});

describe('StatusIndex — incremental equals full rebuild (property)', () => {
  it('matches a fresh rebuild after every effect in a random stream', () => {
    const TASKS = 5;
    const opArb = fc.oneof(
      fc.record({ k: fc.constant('check' as const), t: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('uncheck' as const), t: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('clockIn' as const), t: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('clockOut' as const) }),
      fc.record({ k: fc.constant('edge' as const), p: fc.integer({ min: 0, max: TASKS - 1 }), s: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('delEdge' as const) }),
      fc.record({ k: fc.constant('block' as const), t: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('delBlock' as const) }),
      fc.record({ k: fc.constant('sprintAdd' as const), t: fc.integer({ min: 0, max: TASKS - 1 }) }),
      fc.record({ k: fc.constant('sprintRemove' as const) }),
    );

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const w = world(TASKS);
        const index = new StatusIndex(factRows(w), NOW, SETTINGS);
        const openEntries: string[] = [];
        const liveEdges: string[] = [];
        const liveBlocks: string[] = [];
        const liveMembers: string[] = [];
        let n = 1000;
        const fresh = () => idOf((n += 1));

        for (const op of ops) {
          let effect: StatusEffect | null = null;
          switch (op.k) {
            case 'check': {
              const task = w.tasks[op.t]!;
              if (task.completed_at === null) {
                task.completed_at = past;
                effect = { table: 'nodes', op: 'update', row_id: task.id, fields: { completed_at: past } };
              }
              break;
            }
            case 'uncheck': {
              const task = w.tasks[op.t]!;
              if (task.completed_at !== null) {
                task.completed_at = null;
                effect = { table: 'nodes', op: 'update', row_id: task.id, fields: { completed_at: null } };
              }
              break;
            }
            case 'clockIn': {
              const id = fresh();
              w.time_entries.push(makeEntry({ id, task_id: w.tasks[op.t]!.id, started_at: past }));
              openEntries.push(id);
              effect = { table: 'time_entries', op: 'insert', row_id: id, fields: { task_id: w.tasks[op.t]!.id, started_at: past, ended_at: null } };
              break;
            }
            case 'clockOut': {
              const id = openEntries.pop();
              if (id) {
                const entry = w.time_entries.find((e) => e.id === id)!;
                entry.ended_at = future;
                effect = { table: 'time_entries', op: 'update', row_id: id, fields: { ended_at: future } };
              }
              break;
            }
            case 'edge': {
              if (op.p !== op.s) {
                const [p, s] = op.p < op.s ? [op.p, op.s] : [op.s, op.p]; // keep a DAG
                const id = fresh();
                w.edges.push(makeEdge({ id, predecessor_id: w.tasks[p]!.id, successor_id: w.tasks[s]!.id }));
                liveEdges.push(id);
                effect = { table: 'edges', op: 'insert', row_id: id, fields: { predecessor_id: w.tasks[p]!.id, successor_id: w.tasks[s]!.id, edge_type: 'FS', lag_minutes: 0 } };
              }
              break;
            }
            case 'delEdge': {
              const id = liveEdges.pop();
              if (id) {
                w.edges = w.edges.filter((e) => e.id !== id);
                effect = { table: 'edges', op: 'delete', row_id: id, fields: {} };
              }
              break;
            }
            case 'block': {
              const id = fresh();
              w.schedule_blocks.push(makeBlock({ id, task_id: w.tasks[op.t]!.id, starts_at: past, ends_at: future }));
              liveBlocks.push(id);
              effect = { table: 'schedule_blocks', op: 'insert', row_id: id, fields: { task_id: w.tasks[op.t]!.id, starts_at: past, ends_at: future, status: 'committed' } };
              break;
            }
            case 'delBlock': {
              const id = liveBlocks.pop();
              if (id) {
                w.schedule_blocks = w.schedule_blocks.filter((b) => b.id !== id);
                effect = { table: 'schedule_blocks', op: 'delete', row_id: id, fields: {} };
              }
              break;
            }
            case 'sprintAdd': {
              const id = fresh();
              w.sprint_memberships.push(makeMembership({ id, sprint_id: w.sprint.id, node_id: w.tasks[op.t]!.id }));
              liveMembers.push(id);
              effect = { table: 'sprint_memberships', op: 'insert', row_id: id, fields: { sprint_id: w.sprint.id, node_id: w.tasks[op.t]!.id } };
              break;
            }
            case 'sprintRemove': {
              const id = liveMembers.pop();
              if (id) {
                w.sprint_memberships = w.sprint_memberships.filter((m) => m.id !== id);
                effect = { table: 'sprint_memberships', op: 'delete', row_id: id, fields: {} };
              }
              break;
            }
          }
          if (effect) index.apply([effect]);
          const full = fullStatuses(w);
          for (const [id, status] of full) {
            if (index.statusOf(id) !== status) return false;
          }
          if (index.allStatuses().size !== full.size) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('StatusIndex — locality at scale', () => {
  it('a single command recomputes a bounded set, independent of total node count', () => {
    const w = world(200);
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    // a rename-shaped no-status-impact update still touches at most the node itself
    const res = index.apply([{ table: 'nodes', op: 'update', row_id: w.tasks[7]!.id, fields: { title: 'renamed' } }]);
    expect(res.recomputed).toEqual([w.tasks[7]!.id]);
    expect(res.recomputed.length).toBeLessThan(w.tasks.length);
  });
});

describe('StatusIndex — phase fan-out is scoped to the changed project (S2-F4)', () => {
  it('a completion under one project does not recompute another project`s tasks', () => {
    // vision → { P1: [t0,t1], P2: [u0,u1] }, with a GLOBAL project.phase blocker.
    const vision = makeNode({ id: idOf(1), node_type: 'vision' });
    const p1 = makeNode({ id: idOf(2), node_type: 'project', parent_id: vision.id });
    const p2 = makeNode({ id: idOf(3), node_type: 'project', parent_id: vision.id });
    const t0 = makeNode({ id: idOf(10), node_type: 'task', parent_id: p1.id });
    const t1 = makeNode({ id: idOf(11), node_type: 'task', parent_id: p1.id });
    const u0 = makeNode({ id: idOf(20), node_type: 'task', parent_id: p2.id });
    const u1 = makeNode({ id: idOf(21), node_type: 'task', parent_id: p2.id });
    const rows: FactRows = {
      nodes: [vision, p1, p2, t0, t1, u0, u1],
      blocker_rules: [makeBlockerRule({ id: idOf(950), predicate: { all: [{ fact: 'project.phase', op: 'eq', value: 'idle' }] } })],
      user_settings: SETTINGS,
    };
    const index = new StatusIndex(rows, NOW, SETTINGS);
    const res = index.apply([{ table: 'nodes', op: 'update', row_id: t0.id, fields: { completed_at: past } }]);
    // P1's tasks are recomputed (its phase changed); P2's are untouched.
    expect(res.recomputed).toContain(t1.id);
    expect(res.recomputed).not.toContain(u0.id);
    expect(res.recomputed).not.toContain(u1.id);
    // and every value still equals a fresh rebuild over the POST-completion state
    // (scoping the fan-out narrowed the touch set without changing any value).
    const afterNodes = rows.nodes.map((n) => (n.id === t0.id ? { ...n, completed_at: past } : n));
    const afterCtx = buildFactContext({ ...rows, nodes: afterNodes });
    for (const n of afterNodes) {
      if (n.node_type === 'task') expect(index.statusOf(n.id), `task ${n.id}`).toBe(taskStatus(n, afterCtx, NOW));
    }
  });
});

describe('StatusIndex — freshView is a drop-in FactContext (S8-F1 provider seam)', () => {
  it('exposes sorted children like buildTreeIndex, fresh identity per call, live after apply', () => {
    const vision = makeNode({ id: idOf(1), node_type: 'vision' });
    // siblings deliberately out of sort_order insertion order
    const p = makeNode({ id: idOf(2), node_type: 'project', parent_id: vision.id });
    const c2 = makeNode({ id: idOf(30), node_type: 'task', parent_id: p.id, sort_order: 'a2', title: 'c2' });
    const c0 = makeNode({ id: idOf(31), node_type: 'task', parent_id: p.id, sort_order: 'a0', title: 'c0' });
    const c1 = makeNode({ id: idOf(32), node_type: 'task', parent_id: p.id, sort_order: 'a1', title: 'c1' });
    const rows: FactRows = { nodes: [vision, p, c2, c0, c1], user_settings: SETTINGS };
    const index = new StatusIndex(rows, NOW, SETTINGS, { trackStatus: false });

    const v1 = index.freshView();
    const order1 = (v1.tree.childrenByParent.get(p.id) ?? []).map((n) => n.sort_order);
    expect(order1).toEqual(['a0', 'a1', 'a2']); // sorted like buildTreeIndex
    // matches the reference tree exactly
    const ref = buildFactContext(rows);
    expect((v1.tree.childrenByParent.get(p.id) ?? []).map((n) => n.id)).toEqual((ref.tree.childrenByParent.get(p.id) ?? []).map((n) => n.id));

    // fresh identity per call (so React consumers memoized on the context re-run)
    const v2 = index.freshView();
    expect(v2).not.toBe(v1);
    expect(v2.tree).not.toBe(v1.tree);

    // live after apply: an inserted sibling lands in sorted position in the NEXT view
    index.apply([{ table: 'nodes', op: 'insert', row_id: idOf(33), fields: { node_type: 'task', parent_id: p.id, sort_order: 'a0h', title: 'c0h' } }]);
    const v3 = index.freshView();
    expect((v3.tree.childrenByParent.get(p.id) ?? []).map((n) => n.sort_order)).toEqual(['a0', 'a0h', 'a1', 'a2']);
    // trackStatus:false → no status tracked, but the view/tree is fully maintained
    expect(v3.node(idOf(33))?.title).toBe('c0h');
  });
});

describe('StatusIndex — unknown-row update guard (S2-F5)', () => {
  it('ignores an update effect for a row the index does not hold; inserts still work', () => {
    const w = world(3);
    const index = new StatusIndex(factRows(w), NOW, SETTINGS);
    const ghostId = idOf(9999);
    // an update (e.g. a stray `{deleted_at: null}` restore) for an unknown row:
    // no ghost is fabricated, nothing recomputed, and the skip is counted.
    const res = index.apply([{ table: 'nodes', op: 'update', row_id: ghostId, fields: { deleted_at: null, title: 'ghost' } }]);
    expect(index.statusOf(ghostId)).toBeUndefined();
    expect(res.recomputed).toEqual([]);
    expect(index.skippedUnknownUpdates).toBe(1);
    // an INSERT for a genuinely new task is the only unknown-row entry path.
    index.apply([{ table: 'nodes', op: 'insert', row_id: ghostId, fields: { node_type: 'task', parent_id: w.project.id, title: 'real', sort_order: 'z0' } }]);
    expect(index.statusOf(ghostId)).toBe('available');
    expect(index.skippedUnknownUpdates).toBe(1); // unchanged by the insert
  });
});

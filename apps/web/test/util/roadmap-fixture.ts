/**
 * One roadmap whose projects depend on each other in every way the roll-up has
 * to handle: task → task across projects, a project-level edge, a task inside a
 * milestone, an edge INSIDE one project (ignored), and an edge from another
 * roadmap (ignored). Plus a project nothing links and one with no tasks.
 *
 *   Write a novel (vision)
 *   ├─ Finish the novel (roadmap)
 *   │  ├─ Research         t1 1h DONE                         → unblocks Draft (t1→t2), Revise (p1→p3)
 *   │  ├─ Draft act two    t2 2h DONE · t3 3h · t4 no est.    t3→t4 is inside the project
 *   │  ├─ Revise act one   Opening (milestone): t5 1h DONE · t6 30m;  t7 1h
 *   │  ├─ Beta readers     t8 1h                              waits on Draft (t3→t8) and Revise (t6→t8)
 *   │  ├─ Final draft      t9 2h                              waits on Beta (p4→t9)
 *   │  ├─ Writing habit    t10 30m                            nothing links it
 *   │  └─ Cover ideas      (no tasks)
 *   └─ Build an audience (roadmap)
 *      └─ Newsletter       q1 1h                              q1→t10 crosses roadmaps: ignored
 */
import { buildTreeIndex, SYNC_ROW_DEFAULTS, type Edge, type Node, type NodeType } from '@prisms/core';

const T0 = '2026-01-01T00:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export function roadmapFixture() {
  let seq = 0;
  const rows: Node[] = [];
  const node = (type: NodeType, title: string, parent: Node | null, extra: Partial<Node> = {}): Node => {
    seq += 1;
    const row: Node = {
      id: uuid(seq),
      user_id: uuid(0),
      created_at: T0,
      updated_at: T0,
      deleted_at: null,
      ...SYNC_ROW_DEFAULTS,
      parent_id: parent?.id ?? null,
      node_type: type,
      title,
      description: '',
      sort_order: `a${seq.toString().padStart(3, '0')}`,
      start_date: null,
      due_date: null,
      estimate_minutes: null,
      completed_at: null,
      completion_disposition: null,
      completed_in_block_id: null,
      habit_id: null,
      attributes: {},
      ...extra,
    };
    rows.push(row);
    return row;
  };
  const done = { completed_at: T0, completion_disposition: 'completed' as const };

  const v = node('vision', 'Write a novel', null);
  const r = node('roadmap', 'Finish the novel', v);
  const p1 = node('project', 'Research', r);
  const t1 = node('task', 'Harbour visit', p1, { estimate_minutes: 60, ...done });
  const p2 = node('project', 'Draft act two', r, { due_date: '2026-12-20' });
  const t2 = node('task', 'Outline', p2, { estimate_minutes: 120, ...done });
  const t3 = node('task', 'Write ch. 11', p2, { estimate_minutes: 180 });
  const t4 = node('task', 'Pick a title', p2);
  const p3 = node('project', 'Revise act one', r);
  const m1 = node('milestone', 'Opening', p3);
  const t5 = node('task', 'Read-through', m1, { estimate_minutes: 60, ...done });
  const t6 = node('task', 'Rewrite opening', m1, { estimate_minutes: 30 });
  const t7 = node('task', 'Fix POV slips', p3, { estimate_minutes: 60 });
  const p4 = node('project', 'Beta readers', r);
  const t8 = node('task', 'Send manuscript', p4, { estimate_minutes: 60 });
  const p5 = node('project', 'Final draft', r);
  const t9 = node('task', 'Apply notes', p5, { estimate_minutes: 120 });
  const p6 = node('project', 'Writing habit', r);
  const t10 = node('task', 'Morning pages', p6, { estimate_minutes: 30 });
  const p7 = node('project', 'Cover ideas', r);
  const r2 = node('roadmap', 'Build an audience', v);
  const q = node('project', 'Newsletter', r2);
  const q1 = node('task', 'Issue 2', q, { estimate_minutes: 60 });

  let e = 0;
  const edge = (pred: Node, succ: Node): Edge => ({
    id: uuid(900 + ++e),
    user_id: uuid(0),
    predecessor_id: pred.id,
    successor_id: succ.id,
    edge_type: 'FS',
    lag_minutes: 0,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...SYNC_ROW_DEFAULTS,
  }) as Edge;
  const edges = [edge(t1, t2), edge(p1, p3), edge(t3, t8), edge(t6, t8), edge(p4, t9), edge(t3, t4), edge(q1, t10)];

  return {
    tree: buildTreeIndex(rows),
    edges,
    ids: { v, r, p1, p2, p3, p4, p5, p6, p7, m1, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, r2, q, q1 },
    /** Build a fresh tree with extra rows (e.g. to make a cycle). */
    rows,
    node,
    edge,
  };
}

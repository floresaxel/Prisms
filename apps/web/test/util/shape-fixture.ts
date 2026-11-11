/**
 * One vision's tree, shaped to hit every rule the Shape chart has: a milestone
 * (so a row mixes milestones and tasks), an obsolete task (descoped, counted
 * nowhere), open tasks with and without an estimate, a done task without one,
 * and a roadmap with nothing under it.
 *
 *   Become an author (vision)
 *   ├─ Finish the novel (roadmap)
 *   │  ├─ Draft act two (project)      t1 3h done · t2 6h · t3 6h · t4 no estimate
 *   │  └─ Revise act one (project)
 *   │     ├─ Opening (milestone)       t5 1h done · t6 2h
 *   │     ├─ t7 30m
 *   │     └─ t8 10h OBSOLETE
 *   ├─ Build an audience (roadmap)
 *   │  └─ Newsletter (project)          t9 1h · t10 no estimate, done
 *   └─ Get published (roadmap)          (empty)
 */
import { buildTreeIndex, SYNC_ROW_DEFAULTS, type Node, type NodeType } from '@prisms/core';

const T0 = '2026-01-01T00:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export function shapeFixture() {
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
      sort_order: `a${seq.toString().padStart(3, '0')}`, // creation order = sibling order
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

  const v = node('vision', 'Become an author', null);
  const r1 = node('roadmap', 'Finish the novel', v);
  const p1 = node('project', 'Draft act two', r1);
  const t1 = node('task', 'Outline', p1, { estimate_minutes: 180, ...done });
  const t2 = node('task', 'Write ch. 11', p1, { estimate_minutes: 360 });
  const t3 = node('task', 'Write ch. 12', p1, { estimate_minutes: 360 });
  const t4 = node('task', 'Pick a title', p1);
  const p2 = node('project', 'Revise act one', r1);
  const m1 = node('milestone', 'Opening', p2);
  const t5 = node('task', 'Read-through', m1, { estimate_minutes: 60, ...done });
  const t6 = node('task', 'Rewrite opening', m1, { estimate_minutes: 120 });
  const t7 = node('task', 'Fix POV slips', p2, { estimate_minutes: 30 });
  const t8 = node('task', 'Second POV', p2, { estimate_minutes: 600, completed_at: T0, completion_disposition: 'obsolete' });
  const r2 = node('roadmap', 'Build an audience', v);
  const p3 = node('project', 'Newsletter', r2);
  const t9 = node('task', 'Write issue 2', p3, { estimate_minutes: 60 });
  const t10 = node('task', 'Pick a platform', p3, done);
  const r3 = node('roadmap', 'Get published', v);
  const empty = node('vision', 'Nothing yet', null);

  return {
    tree: buildTreeIndex(rows),
    ids: { v, r1, p1, p2, m1, r2, p3, r3, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, empty },
  };
}

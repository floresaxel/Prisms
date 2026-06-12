/** S5 DoD: project phase derivation tests (§7.1). */
import { describe, expect, it } from 'vitest';

import { buildFactContext, type FactRows } from '../../src/status/context';
import { projectPhase } from '../../src/status/phase';
import { isoToEpochMillis } from '../../src/time/instant';
import { idOf, makeBlock, makeEntry, makeNode } from '../helpers/fixtures';

const NOW = isoToEpochMillis('2026-06-12T16:00:00.000Z');
const PROJECT = idOf(1);
const MILESTONE = idOf(2);

function projectWithTasks(
  tasks: { id: string; done?: boolean; underMilestone?: boolean }[],
  extra: Partial<FactRows> = {},
) {
  const nodes = [
    makeNode({ id: PROJECT, node_type: 'project' }),
    makeNode({ id: MILESTONE, node_type: 'milestone', parent_id: PROJECT }),
    ...tasks.map((t) =>
      makeNode({
        id: t.id,
        node_type: 'task',
        parent_id: t.underMilestone ? MILESTONE : PROJECT,
        completed_at: t.done ? '2026-06-10T12:00:00.000Z' : null,
      }),
    ),
  ];
  return buildFactContext({ nodes, ...extra });
}

describe('projectPhase (§7.1)', () => {
  it('no tasks ⇒ idle (milestones alone do not count)', () => {
    expect(projectPhase(PROJECT, projectWithTasks([]), NOW)).toBe('idle');
  });

  it('all tasks done ⇒ completed (including tasks nested under milestones)', () => {
    const ctx = projectWithTasks([
      { id: idOf(10), done: true },
      { id: idOf(11), done: true, underMilestone: true },
    ]);
    expect(projectPhase(PROJECT, ctx, NOW)).toBe('completed');
  });

  it('some done, some not ⇒ executing', () => {
    const ctx = projectWithTasks([{ id: idOf(10), done: true }, { id: idOf(11) }]);
    expect(projectPhase(PROJECT, ctx, NOW)).toBe('executing');
  });

  it('any ongoing task ⇒ executing', () => {
    const ctx = projectWithTasks([{ id: idOf(10) }, { id: idOf(11) }], {
      time_entries: [
        makeEntry({ id: idOf(100), task_id: idOf(10), started_at: '2026-06-12T15:00:00.000Z' }),
      ],
    });
    expect(projectPhase(PROJECT, ctx, NOW)).toBe('executing');
  });

  it('only scheduled work ⇒ planned; executing outranks planned', () => {
    const block = makeBlock({
      id: idOf(101),
      task_id: idOf(10),
      starts_at: '2026-06-13T09:00:00.000Z',
      ends_at: '2026-06-13T10:00:00.000Z',
    });
    const planned = projectWithTasks([{ id: idOf(10) }, { id: idOf(11) }], {
      schedule_blocks: [block],
    });
    expect(projectPhase(PROJECT, planned, NOW)).toBe('planned');

    const mixed = projectWithTasks([{ id: idOf(10) }, { id: idOf(11), done: true }], {
      schedule_blocks: [block],
    });
    expect(projectPhase(PROJECT, mixed, NOW)).toBe('executing');
  });

  it('untouched tasks only ⇒ idle', () => {
    expect(projectPhase(PROJECT, projectWithTasks([{ id: idOf(10) }]), NOW)).toBe('idle');
  });

  it('unknown project id ⇒ idle (no subtree)', () => {
    expect(projectPhase(idOf(99), projectWithTasks([{ id: idOf(10) }]), NOW)).toBe('idle');
  });
});

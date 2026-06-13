/**
 * S6 DoD: `incremental ∘ facts === canonical(facts)` for the sum-style
 * metrics (effective/practice hours, task progress, project completion) over
 * randomized fact streams — including shuffled order, since sums commute.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { effectiveHours, effectiveMinutes, rawMinutes } from '../../src/aggregates/effective';
import {
  canonicalCompletion,
  incrementalCompletion,
  taskWeight,
  type CompletionToggle,
} from '../../src/aggregates/completion';
import {
  canonicalPractice,
  emptyPractice,
  habitTaskIds,
  incrementalPractice,
} from '../../src/aggregates/practice';
import {
  canonicalProgress,
  emptyProgress,
  incrementalProgress,
} from '../../src/aggregates/progress';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeEntry, makeHabit, makeNode } from '../helpers/fixtures';
import type { Node, TimeEntry } from '../../src/domain/entities';

const HABIT = makeHabit({
  id: idOf(900),
  vision_id: idOf(1),
  mastery_target_hours: 10_000,
  level_thresholds_hours: [1, 5, 50],
});

/** Entry arb: minutes ∈ [0, 600], focus ∈ {null, 0.5..1.0}, on one of 4 tasks. */
const entryArb = (seq: number) =>
  fc
    .record({
      task: fc.integer({ min: 0, max: 3 }),
      minutes: fc.integer({ min: 0, max: 600 }),
      focus: fc.option(
        fc.float({ min: Math.fround(0.5), max: 1, noNaN: true }),
        { nil: null },
      ),
      deleted: fc.boolean(),
    })
    .map(({ task, minutes, focus, deleted }, ) => {
      const startMs = Date.UTC(2026, 5, 1, 8) + seq * 86_400_000;
      return makeEntry({
        id: idOf(1000 + seq),
        task_id: idOf(10 + task),
        started_at: new Date(startMs).toISOString(),
        ended_at: new Date(startMs + minutes * 60_000).toISOString(),
        focus_factor: focus,
        deleted_at: deleted ? '2026-06-30T00:00:00.000Z' : null,
      });
    });

const entriesArb = fc
  .integer({ min: 0, max: 25 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => entryArb(i))));

describe('effective time (§7.2)', () => {
  it('goldens: focus default 1.0, ×0.5 halves, open entries contribute 0', () => {
    const closed = makeEntry({
      id: idOf(1),
      task_id: idOf(10),
      started_at: '2026-06-12T10:00:00.000Z',
      ended_at: '2026-06-12T11:30:00.000Z',
    });
    expect(rawMinutes(closed)).toBe(90);
    expect(effectiveMinutes(closed)).toBe(90);
    expect(effectiveMinutes({ ...closed, focus_factor: 0.5 })).toBe(45);
    expect(effectiveHours({ ...closed, focus_factor: 0.5 })).toBe(0.75);
    expect(effectiveMinutes({ ...closed, ended_at: null })).toBe(0);
  });
});

describe('practice hours + levels (§7.2)', () => {
  // tasks 10, 11 belong to the skill; 12, 13 do not
  const nodes: Node[] = [
    makeNode({ id: idOf(10), node_type: 'task', habit_id: HABIT.id }),
    makeNode({ id: idOf(11), node_type: 'task', habit_id: HABIT.id }),
    makeNode({ id: idOf(12), node_type: 'task' }),
    makeNode({ id: idOf(13), node_type: 'task', habit_id: idOf(901) }),
  ];

  it('property: shuffled incremental fold === canonical', () => {
    fc.assert(
      fc.property(entriesArb, fc.infiniteStream(fc.nat()), (entries, shuffle) => {
        const shuffled = [...entries].sort(() => (shuffle.next().value % 3) - 1);
        const tasks = habitTaskIds(HABIT, nodes);
        const folded = shuffled.reduce(
          (acc, entry) => incrementalPractice(acc, entry, HABIT, tasks),
          emptyPractice(HABIT),
        );
        const canonical = canonicalPractice(HABIT, nodes, entries as TimeEntry[]);
        expect(folded.minutes).toBeCloseTo(canonical.minutes, 6);
        expect(folded.level).toBe(canonical.level);
        expect(folded.nextThresholdHours).toBe(canonical.nextThresholdHours);
      }),
    );
  });

  it('levels pass thresholds in hours', () => {
    const entry = (minutes: number, seq: number) =>
      makeEntry({
        id: idOf(2000 + seq),
        task_id: idOf(10),
        started_at: '2026-06-12T00:00:00.000Z',
        ended_at: new Date(Date.UTC(2026, 5, 12, 0, minutes)).toISOString(),
      });
    // 6 hours total → past thresholds 1 and 5, next is 50
    const value = canonicalPractice(HABIT, nodes, [entry(300, 0), entry(60, 1)]);
    expect(value.hours).toBe(6);
    expect(value.level).toBe(2);
    expect(value.nextThresholdHours).toBe(50);
  });
});

describe('task progress (§7.2)', () => {
  const task = makeNode({ id: idOf(10), node_type: 'task', estimate_minutes: 120 });

  it('property: shuffled incremental fold === canonical', () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const own = entries.filter((e) => e.task_id === task.id);
        const folded = own.reduce(
          (acc, entry) => incrementalProgress(acc, entry),
          emptyProgress(task),
        );
        const canonical = canonicalProgress(task, entries as TimeEntry[]);
        expect(folded.consumedMinutes).toBeCloseTo(canonical.consumedMinutes, 6);
        expect(folded.percent).toBeCloseTo(canonical.percent, 6);
      }),
    );
  });

  it('caps display at 100% and keeps overflow in ratio', () => {
    const entries = [
      makeEntry({
        id: idOf(1),
        task_id: task.id,
        started_at: '2026-06-12T08:00:00.000Z',
        ended_at: '2026-06-12T11:00:00.000Z', // 180 of 120
      }),
    ];
    const value = canonicalProgress(task, entries);
    expect(value.percent).toBe(100);
    expect(value.ratio).toBeCloseTo(1.5, 6);
    expect(canonicalProgress({ ...task, estimate_minutes: null }, entries).percent).toBe(0);
  });
});

describe('project completion % (§7.2)', () => {
  function world(completed: boolean[]) {
    const project = makeNode({ id: idOf(1), node_type: 'project' });
    const milestone = makeNode({ id: idOf(2), node_type: 'milestone', parent_id: project.id });
    const tasks = completed.map((done, i) =>
      makeNode({
        id: idOf(10 + i),
        node_type: 'task',
        parent_id: i % 2 === 0 ? project.id : milestone.id,
        estimate_minutes: i % 3 === 0 ? null : (i + 1) * 30, // weight fallback 1 exercised
        completed_at: done ? '2026-06-10T12:00:00.000Z' : null,
      }),
    );
    return { project, nodes: [project, milestone, ...tasks], tasks };
  }

  it('property: random toggle streams fold to canonical', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), // initial states
        fc.array(fc.nat(), { minLength: 0, maxLength: 30 }), // toggle targets
        (initial, toggles) => {
          const { project, nodes, tasks } = world(initial);
          const state = [...initial];
          let value = canonicalCompletion(project.id, buildTreeIndex(nodes));
          for (const t of toggles) {
            const i = t % state.length;
            state[i] = !state[i];
            const toggle: CompletionToggle = {
              weight: taskWeight(tasks[i]!),
              completed: state[i]!,
            };
            value = incrementalCompletion(value, toggle);
          }
          const finalNodes = nodes.map((n) => {
            const idx = tasks.findIndex((t) => t.id === n.id);
            if (idx === -1) return n;
            return { ...n, completed_at: state[idx] ? '2026-06-11T12:00:00.000Z' : null };
          });
          const canonical = canonicalCompletion(project.id, buildTreeIndex(finalNodes));
          expect(value.completedWeight).toBeCloseTo(canonical.completedWeight, 6);
          expect(value.percent).toBeCloseTo(canonical.percent, 6);
        },
      ),
    );
  });

  it('weights estimates with fallback 1; empty project is 0%', () => {
    const { project, nodes } = world([true, false]);
    // task0: weight 1 (null estimate, completed); task1: weight 60 (open)
    const value = canonicalCompletion(project.id, buildTreeIndex(nodes));
    expect(value.totalWeight).toBe(61);
    expect(value.completedWeight).toBe(1);
    const empty = canonicalCompletion(idOf(99), buildTreeIndex(nodes));
    expect(empty.percent).toBe(0);
  });
});

/**
 * Hours/progress aggregates (§9.2): canonical values consume the §7.10b
 * union resolver PER TASK — overlapping entries count once, never twice
 * (audit S3-F2/S5-F4). Properties: order-independence, duplication-
 * idempotence (a union invariant per-entry sums violate), union ≤ naive sum;
 * plus overlap goldens. Completion keeps its incremental-fold property
 * (completion is a toggle sum, not an interval aggregate).
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
import { canonicalPractice, habitTaskIds } from '../../src/aggregates/practice';
import { canonicalProgress } from '../../src/aggregates/progress';
import { habitTodayMinutes } from '../../src/aggregates/today';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeEntry, makeHabit, makeNode } from '../helpers/fixtures';
import type { Node, TimeEntry } from '../../src/domain/entities';

const HABIT = makeHabit({
  id: idOf(900),
  vision_id: idOf(1),
  mastery_target_hours: 10_000,
  level_thresholds_hours: [1, 5, 50],
});

/**
 * Overlap-capable arb: entries land inside ONE day window on 2 tasks, so
 * union ≠ sum cases are actually generated (a per-day arb can never overlap
 * — which is exactly how the pre-union per-entry sums looked correct).
 */
const overlappingEntriesArb = fc
  .array(
    fc.record({
      task: fc.integer({ min: 0, max: 1 }),
      startMin: fc.integer({ min: 0, max: 600 }),
      durMin: fc.integer({ min: 1, max: 240 }),
      focus: fc.option(
        fc.float({ min: Math.fround(0.5), max: 1, noNaN: true }),
        { nil: null },
      ),
      deleted: fc.boolean(),
    }),
    { minLength: 0, maxLength: 12 },
  )
  .map((rows) =>
    rows.map((r, i) => {
      const startMs = Date.UTC(2026, 5, 1, 8) + r.startMin * 60_000;
      return makeEntry({
        id: idOf(3000 + i),
        task_id: idOf(10 + r.task),
        started_at: new Date(startMs).toISOString(),
        ended_at: new Date(startMs + r.durMin * 60_000).toISOString(),
        focus_factor: r.focus,
        deleted_at: r.deleted ? '2026-06-30T00:00:00.000Z' : null,
      });
    }),
  );

/** The audit's overlap pair on one habit task: 09:00–11:00 ∪ 09:30–10:30. */
const overlapPair = (focusLong: number | null = null, focusShort: number | null = null) => [
  makeEntry({
    id: idOf(3100),
    task_id: idOf(10),
    started_at: '2026-06-12T09:00:00.000Z',
    ended_at: '2026-06-12T11:00:00.000Z',
    focus_factor: focusLong,
  }),
  makeEntry({
    id: idOf(3101),
    task_id: idOf(10),
    started_at: '2026-06-12T09:30:00.000Z',
    ended_at: '2026-06-12T10:30:00.000Z',
    focus_factor: focusShort,
  }),
];

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

  it('golden: overlapping same-task entries union, not sum (audit S3-F2)', () => {
    // 09:00–11:00 ∪ 09:30–10:30 = 120 min; the per-entry sum would be 180.
    const value = canonicalPractice(HABIT, nodes, overlapPair() as TimeEntry[]);
    expect(value.minutes).toBe(120);
    expect(value.hours).toBe(2);
    expect(value.level).toBe(1); // past the 1h threshold only
  });

  it('golden: focus integrates as max-per-instant over the union (§7.10b)', () => {
    // long@0.5, short@1.0 → 30·0.5 + 60·1.0 + 30·0.5 = 90 effective minutes.
    const value = canonicalPractice(HABIT, nodes, overlapPair(0.5, 1.0) as TimeEntry[]);
    expect(value.minutes).toBeCloseTo(90, 6);
  });

  it('golden: unions are per task — concurrent entries on two tasks both count', () => {
    const sameWallTime = (task: number, seq: number) =>
      makeEntry({
        id: idOf(3200 + seq),
        task_id: idOf(10 + task), // tasks 10 and 11 both belong to HABIT
        started_at: '2026-06-12T09:00:00.000Z',
        ended_at: '2026-06-12T10:00:00.000Z',
      });
    const value = canonicalPractice(HABIT, nodes, [sameWallTime(0, 0), sameWallTime(1, 1)] as TimeEntry[]);
    expect(value.minutes).toBe(120);
  });

  it('property: order-independent, duplication-idempotent, union ≤ naive sum', () => {
    fc.assert(
      fc.property(overlappingEntriesArb, fc.infiniteStream(fc.nat()), (entries, shuffle) => {
        const canonical = canonicalPractice(HABIT, nodes, entries as TimeEntry[]);
        // order-independence
        const shuffled = [...entries].sort(() => (shuffle.next().value % 3) - 1);
        expect(canonicalPractice(HABIT, nodes, shuffled as TimeEntry[]).minutes).toBeCloseTo(canonical.minutes, 6);
        // duplication-idempotence — a union invariant a per-entry sum violates
        const doubled = [...entries, ...entries];
        expect(canonicalPractice(HABIT, nodes, doubled as TimeEntry[]).minutes).toBeCloseTo(canonical.minutes, 6);
        // never more than the naive per-entry sum
        const tasks = habitTaskIds(HABIT, nodes);
        const naive = entries.reduce(
          (acc, e) => acc + (e.deleted_at === null && tasks.has(e.task_id) ? effectiveMinutes(e) : 0),
          0,
        );
        expect(canonical.minutes).toBeLessThanOrEqual(naive + 1e-6);
      }),
    );
  });

  it('levels pass thresholds in hours', () => {
    // NB: the pre-union fixture started BOTH entries at 00:00 (the 1h session
    // contained in the 5h one) and still expected 6h — passing only because
    // per-entry sums double-counted (audit S3-F2). Disjoint sessions now.
    const entry = (startHour: number, minutes: number, seq: number) =>
      makeEntry({
        id: idOf(2000 + seq),
        task_id: idOf(10),
        started_at: new Date(Date.UTC(2026, 5, 12, startHour)).toISOString(),
        ended_at: new Date(Date.UTC(2026, 5, 12, startHour, minutes)).toISOString(),
      });
    // 5h + 1h, sequential → 6 hours → past thresholds 1 and 5, next is 50
    const value = canonicalPractice(HABIT, nodes, [entry(0, 300, 0), entry(6, 60, 1)]);
    expect(value.hours).toBe(6);
    expect(value.level).toBe(2);
    expect(value.nextThresholdHours).toBe(50);
  });
});

describe('task progress (§7.2)', () => {
  const task = makeNode({ id: idOf(10), node_type: 'task', estimate_minutes: 120 });

  it('golden: overlapping entries union — 120 consumed of 120, not 180 (audit S3-F2)', () => {
    const value = canonicalProgress(task, overlapPair() as TimeEntry[]);
    expect(value.consumedMinutes).toBe(120);
    expect(value.percent).toBe(100);
    expect(value.ratio).toBeCloseTo(1.0, 6);
  });

  it('property: duplication-idempotent and union ≤ naive sum', () => {
    fc.assert(
      fc.property(overlappingEntriesArb, (entries) => {
        const canonical = canonicalProgress(task, entries as TimeEntry[]);
        const doubled = [...entries, ...entries];
        expect(canonicalProgress(task, doubled as TimeEntry[]).consumedMinutes).toBeCloseTo(
          canonical.consumedMinutes,
          6,
        );
        const naive = entries.reduce(
          (acc, e) => acc + (e.deleted_at === null && e.task_id === task.id ? rawMinutes(e) : 0),
          0,
        );
        expect(canonical.consumedMinutes).toBeLessThanOrEqual(naive + 1e-6);
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

describe('habit today-minutes (§7.2 ring, §9.2)', () => {
  const taskIds = new Set([idOf(10)]);
  const NOW = Date.UTC(2026, 5, 12, 12); // 2026-06-12T12:00Z

  it('golden: closed union per task + live elapsed for the open entry; other buckets/tasks excluded', () => {
    const entries = [
      // overlapping closed pair on task 10 → 90 min union (10:00–11:30), not 120
      makeEntry({ id: idOf(4000), task_id: idOf(10), started_at: '2026-06-12T10:00:00.000Z', ended_at: '2026-06-12T11:00:00.000Z' }),
      makeEntry({ id: idOf(4001), task_id: idOf(10), started_at: '2026-06-12T10:30:00.000Z', ended_at: '2026-06-12T11:30:00.000Z' }),
      // running entry started 11:30, now 12:00 → +30 live
      makeEntry({ id: idOf(4002), task_id: idOf(10), started_at: '2026-06-12T11:30:00.000Z', ended_at: null }),
      // yesterday's bucket — excluded
      makeEntry({ id: idOf(4003), task_id: idOf(10), started_at: '2026-06-11T10:00:00.000Z', ended_at: '2026-06-11T11:00:00.000Z' }),
      // not this habit's task — excluded
      makeEntry({ id: idOf(4004), task_id: idOf(99), started_at: '2026-06-12T10:00:00.000Z', ended_at: '2026-06-12T11:00:00.000Z' }),
      // deleted — excluded
      makeEntry({ id: idOf(4005), task_id: idOf(10), started_at: '2026-06-12T09:00:00.000Z', ended_at: '2026-06-12T09:30:00.000Z', deleted_at: '2026-06-30T00:00:00.000Z' }),
    ];
    const minutes = habitTodayMinutes(entries as TimeEntry[], taskIds, '2026-06-12', 0, 'UTC', NOW);
    expect(minutes).toBeCloseTo(90 + 30, 6);
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

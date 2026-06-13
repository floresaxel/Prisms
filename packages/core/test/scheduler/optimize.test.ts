/**
 * S9 goldens (§10 soft objectives, §11): objective regression (optimize ≥
 * greedy on canned plans, strictly better when reordering helps),
 * determinism under a fixed Rng seed, and proposal diffing vs the committed
 * plan.
 */
import { describe, expect, it } from 'vitest';

import { scheduleGreedy } from '../../src/scheduler/greedy';
import { DEFAULT_WEIGHTS, scheduleOptimize, scorePlan } from '../../src/scheduler/optimize';
import { schedule } from '../../src/scheduler/greedy';
import type { NamedWindow, SchedulableTask, SchedulerInput } from '../../src/scheduler/types';
import { createSeededRng } from '../../src/time/rng';
import { isoToEpochMillis as iso } from '../../src/time/instant';
import { idOf } from '../helpers/fixtures';

const HALF_DAY: NamedWindow = { id: 'day', startMinute: 9 * 60, endMinute: 13 * 60 }; // 4h
const FULL_DAY: NamedWindow = { id: 'day', startMinute: 9 * 60, endMinute: 17 * 60 }; // 8h
const HORIZON = { from: iso('2026-06-15T00:00:00.000Z'), to: iso('2026-06-22T00:00:00.000Z') };

function plan(
  tasks: readonly SchedulableTask[],
  windows: readonly NamedWindow[],
  over: Partial<SchedulerInput> = {},
): SchedulerInput {
  return {
    tasks,
    committed: [],
    windows,
    timezone: 'UTC',
    horizon: HORIZON,
    mode: 'optimize',
    ...over,
  };
}

const greedyOf = (p: SchedulerInput) => scheduleGreedy({ ...p, mode: 'greedy' });
const isoOf = (ms: number) => new Date(ms).toISOString();

// --- five canned regression plans -----------------------------------------
const dueDatePlan = plan(
  [
    { id: idOf(1), estimateMinutes: 240, dueDate: '2026-06-20' }, // far due, low id ⇒ greedy first
    { id: idOf(2), estimateMinutes: 240, dueDate: '2026-06-15' }, // due today, needs to go first
  ],
  [HALF_DAY],
);
const sprintPlan = plan(
  [
    { id: idOf(1), estimateMinutes: 120 },
    { id: idOf(2), estimateMinutes: 120 },
    { id: idOf(3), estimateMinutes: 120, sprintMember: true }, // high id ⇒ greedy last
  ],
  [FULL_DAY],
);
const dailyTargetPlan = plan(
  [
    { id: idOf(1), estimateMinutes: 60, dailyTargetMinutes: 60 },
    { id: idOf(2), estimateMinutes: 30, dailyTargetMinutes: 60 },
  ],
  [FULL_DAY],
);
const dependencyPlan = plan(
  [
    { id: idOf(1), estimateMinutes: 120, dueDate: '2026-06-19' },
    {
      id: idOf(2),
      estimateMinutes: 120,
      dueDate: '2026-06-15',
      dependencies: [{ predecessorId: idOf(3), edgeType: 'FS', lagMinutes: 0 }],
    },
    { id: idOf(3), estimateMinutes: 120, dueDate: '2026-06-15' },
  ],
  [FULL_DAY],
);
const mixedPlan = plan(
  [
    { id: idOf(1), estimateMinutes: 180, dueDate: '2026-06-21' },
    { id: idOf(2), estimateMinutes: 180, dueDate: '2026-06-16', sprintMember: true },
    { id: idOf(3), estimateMinutes: 120, dueDate: '2026-06-17' },
  ],
  [HALF_DAY],
);

const ALL_PLANS = { dueDatePlan, sprintPlan, dailyTargetPlan, dependencyPlan, mixedPlan };

describe('objective regression (DoD): optimize never scores below greedy', () => {
  it.each(Object.entries(ALL_PLANS))('%s: score(optimize) ≥ score(greedy)', (_name, p) => {
    const greedy = greedyOf(p);
    const optimized = scheduleOptimize(p);
    expect(scorePlan(optimized, p)).toBeGreaterThanOrEqual(scorePlan(greedy, p));
  });

  it('strictly beats greedy when reordering reduces lateness (due dates)', () => {
    const greedy = greedyOf(dueDatePlan);
    const optimized = scheduleOptimize(dueDatePlan);
    expect(scorePlan(optimized, dueDatePlan)).toBeGreaterThan(scorePlan(greedy, dueDatePlan));
    // the due-today task is placed on day 1; nothing is late
    const due2 = optimized.proposals.find((x) => x.taskId === idOf(2))!;
    expect(isoOf(due2.startsAt)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('strictly beats greedy by placing a sprint member earlier', () => {
    const greedy = greedyOf(sprintPlan);
    const optimized = scheduleOptimize(sprintPlan);
    expect(scorePlan(optimized, sprintPlan)).toBeGreaterThan(scorePlan(greedy, sprintPlan));
    const sprintBlock = optimized.proposals.find((x) => x.taskId === idOf(3))!;
    expect(isoOf(sprintBlock.startsAt)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('still honors dependencies while optimizing (predecessor before successor)', () => {
    const optimized = scheduleOptimize(dependencyPlan);
    const pred = optimized.proposals.find((x) => x.taskId === idOf(3))!;
    const succ = optimized.proposals.find((x) => x.taskId === idOf(2))!;
    expect(succ.startsAt).toBeGreaterThanOrEqual(pred.endsAt);
  });
});

describe('determinism (DoD): fixed Rng seed ⇒ identical output', () => {
  it('the default (fixed-seed) optimizer is reproducible', () => {
    expect(scheduleOptimize(mixedPlan)).toEqual(scheduleOptimize(mixedPlan));
  });

  it('an explicitly injected seed reproduces byte-for-byte', () => {
    const a = scheduleOptimize({ ...mixedPlan, optimize: { rng: createSeededRng(42) } });
    const b = scheduleOptimize({ ...mixedPlan, optimize: { rng: createSeededRng(42) } });
    expect(a).toEqual(b);
  });

  it('more iterations never lowers the achieved score', () => {
    const few = scheduleOptimize({ ...mixedPlan, optimize: { iterations: 0 } });
    const many = scheduleOptimize({ ...mixedPlan, optimize: { iterations: 400 } });
    expect(scorePlan(many, mixedPlan)).toBeGreaterThanOrEqual(scorePlan(few, mixedPlan));
  });
});

describe('proposal diffing (§2.6): only changes vs the committed plan are emitted', () => {
  it('emits nothing when the committed flexible block already matches the optimum', () => {
    const single = plan([{ id: idOf(1), estimateMinutes: 60 }], [FULL_DAY], { mode: 'optimize' });
    const optimum = scheduleOptimize(single).proposals[0]!;
    const withCommitted: SchedulerInput = {
      ...single,
      committed: [
        {
          id: idOf(50),
          taskId: idOf(1),
          startsAt: optimum.startsAt,
          endsAt: optimum.endsAt,
          anchored: false,
        },
      ],
    };
    expect(scheduleOptimize(withCommitted).proposals).toEqual([]);
  });

  it('emits a proposal when the task should move from its committed block', () => {
    const single = plan([{ id: idOf(1), estimateMinutes: 60 }], [FULL_DAY], { mode: 'optimize' });
    const withCommitted: SchedulerInput = {
      ...single,
      committed: [
        {
          id: idOf(50),
          taskId: idOf(1),
          startsAt: iso('2026-06-15T11:00:00.000Z'), // suboptimal (its own flexible block is freed)
          endsAt: iso('2026-06-15T12:00:00.000Z'),
          anchored: false,
        },
      ],
    };
    const out = scheduleOptimize(withCommitted);
    expect(out.proposals).toHaveLength(1);
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('schedule(mode:optimize) routes here and weights are overridable', () => {
    const out = schedule({ ...sprintPlan, optimize: { weights: { sprint: 5 } } });
    expect(out.proposals).toHaveLength(3);
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('strongly penalizes dropping work so optimize avoids unplaceable tasks', () => {
    expect(DEFAULT_WEIGHTS.unplaceable).toBeGreaterThan(DEFAULT_WEIGHTS.dueDate * 100000);
  });
});

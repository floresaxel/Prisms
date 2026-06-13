/**
 * S8 goldens (§10): earliest-fit placement, window hints, anchored
 * collisions, dependency+lag ordering, the single-task reschedule entry
 * point, and every unplaceable reason.
 */
import { describe, expect, it } from 'vitest';

import {
  rescheduleTask,
  schedule,
  scheduleGreedy,
  validWindowsFor,
} from '../../src/scheduler/greedy';
import type {
  CommittedBlock,
  NamedWindow,
  SchedulableTask,
  SchedulerInput,
} from '../../src/scheduler/types';
import { isoToEpochMillis as iso } from '../../src/time/instant';
import { idOf } from '../helpers/fixtures';

// Windows in UTC keep the golden arithmetic transparent.
const MORNING: NamedWindow = { id: 'morning', startMinute: 9 * 60, endMinute: 12 * 60 };
const AFTERNOON: NamedWindow = { id: 'afternoon', startMinute: 13 * 60, endMinute: 17 * 60 };

function input(over: Partial<SchedulerInput> & { tasks: readonly SchedulableTask[] }): SchedulerInput {
  return {
    committed: [],
    windows: [MORNING, AFTERNOON],
    timezone: 'UTC',
    horizon: { from: iso('2026-06-15T00:00:00.000Z'), to: iso('2026-06-20T00:00:00.000Z') },
    mode: 'greedy',
    ...over,
  };
}

const isoOf = (ms: number) => new Date(ms).toISOString();

describe('earliest-fit placement (§10)', () => {
  it('places a task at the first window start', () => {
    const out = scheduleGreedy(input({ tasks: [{ id: idOf(1), estimateMinutes: 60 }] }));
    expect(out.unplaceable).toEqual([]);
    expect(out.proposals).toHaveLength(1);
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T09:00:00.000Z');
    expect(isoOf(out.proposals[0]!.endsAt)).toBe('2026-06-15T10:00:00.000Z');
  });

  it('packs sequential tasks back-to-back within a window, then overflows to the next', () => {
    const tasks: SchedulableTask[] = [
      { id: idOf(1), estimateMinutes: 120 },
      { id: idOf(2), estimateMinutes: 120 },
      { id: idOf(3), estimateMinutes: 120 },
    ];
    const out = scheduleGreedy(input({ tasks }));
    // morning is 3h: task1 09:00-11:00, task2 11:00-13:00 won't fit (window ends 12:00)
    // so task2 → 11:00? no, 120min from 11:00 = 13:00 > 12:00. task2 → afternoon 13:00-15:00.
    const starts = out.proposals.map((p) => isoOf(p.startsAt));
    expect(starts).toEqual([
      '2026-06-15T09:00:00.000Z', // task1 morning
      '2026-06-15T13:00:00.000Z', // task2 afternoon (didn't fit in morning tail)
      '2026-06-15T15:00:00.000Z', // task3 afternoon
    ]);
  });

  it('confines a window-restricted task to its window, overflowing to the next day', () => {
    // an anchored block fills the entire first-day morning
    const committed: CommittedBlock[] = [
      {
        id: idOf(90),
        taskId: idOf(90),
        startsAt: iso('2026-06-15T09:00:00.000Z'),
        endsAt: iso('2026-06-15T12:00:00.000Z'),
        anchored: true,
      },
    ];
    const out = scheduleGreedy(
      input({
        committed,
        tasks: [{ id: idOf(1), estimateMinutes: 60, allowedWindowIds: ['morning'] }],
      }),
    );
    // morning-only ⇒ cannot use the afternoon; next free morning is day 2
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-16T09:00:00.000Z');
  });
});

describe('anchored blocks (I7/I9)', () => {
  it('never overlaps an anchored block — fits the task after it', () => {
    const committed: CommittedBlock[] = [
      {
        id: idOf(90),
        taskId: idOf(90),
        startsAt: iso('2026-06-15T09:00:00.000Z'),
        endsAt: iso('2026-06-15T10:00:00.000Z'),
        anchored: true,
      },
    ];
    const out = scheduleGreedy(
      input({ committed, tasks: [{ id: idOf(1), estimateMinutes: 60, allowedWindowIds: ['morning'] }] }),
    );
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T10:00:00.000Z');
  });

  it('an anchored block is an obstacle even for its own task (cannot be moved)', () => {
    const committed: CommittedBlock[] = [
      {
        id: idOf(1),
        taskId: idOf(1),
        startsAt: iso('2026-06-15T09:00:00.000Z'),
        endsAt: iso('2026-06-15T10:00:00.000Z'),
        anchored: true,
      },
    ];
    // rescheduling task 1 must not place over its own anchored block
    const out = scheduleGreedy(
      input({ committed, tasks: [{ id: idOf(1), estimateMinutes: 60, allowedWindowIds: ['morning'] }] }),
    );
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T10:00:00.000Z');
  });

  it('a flexible block of a replanned task IS freed', () => {
    const committed: CommittedBlock[] = [
      {
        id: idOf(1),
        taskId: idOf(1),
        startsAt: iso('2026-06-15T11:00:00.000Z'),
        endsAt: iso('2026-06-15T12:00:00.000Z'),
        anchored: false,
      },
    ];
    const out = scheduleGreedy(
      input({ committed, tasks: [{ id: idOf(1), estimateMinutes: 60, allowedWindowIds: ['morning'] }] }),
    );
    // its own flexible block is freed, so earliest-fit reclaims 09:00
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T09:00:00.000Z');
  });
});

describe('dependencies + lag (§10 hard constraint)', () => {
  it('FS: successor starts after predecessor ends + lag', () => {
    const tasks: SchedulableTask[] = [
      { id: idOf(2), estimateMinutes: 60, dependencies: [{ predecessorId: idOf(1), edgeType: 'FS', lagMinutes: 30 }] },
      { id: idOf(1), estimateMinutes: 60 },
    ];
    const out = scheduleGreedy(input({ tasks }));
    const a = out.proposals.find((p) => p.taskId === idOf(1))!;
    const b = out.proposals.find((p) => p.taskId === idOf(2))!;
    expect(isoOf(a.startsAt)).toBe('2026-06-15T09:00:00.000Z'); // 09:00-10:00
    expect(b.startsAt).toBe(a.endsAt + 30 * 60_000); // 10:30
    expect(isoOf(b.startsAt)).toBe('2026-06-15T10:30:00.000Z');
  });

  it('SS: successor starts after predecessor starts + lag', () => {
    const tasks: SchedulableTask[] = [
      { id: idOf(1), estimateMinutes: 60 },
      { id: idOf(2), estimateMinutes: 60, dependencies: [{ predecessorId: idOf(1), edgeType: 'SS', lagMinutes: 60 }] },
    ];
    const out = scheduleGreedy(input({ tasks }));
    const b = out.proposals.find((p) => p.taskId === idOf(2))!;
    expect(isoOf(b.startsAt)).toBe('2026-06-15T10:00:00.000Z'); // 09:00 + 60min
  });

  it('a dependency on an external committed block constrains timing', () => {
    const committed: CommittedBlock[] = [
      {
        id: idOf(90),
        taskId: idOf(90),
        startsAt: iso('2026-06-15T09:00:00.000Z'),
        endsAt: iso('2026-06-15T10:30:00.000Z'),
        anchored: true,
      },
    ];
    const out = scheduleGreedy(
      input({
        committed,
        tasks: [
          {
            id: idOf(1),
            estimateMinutes: 60,
            dependencies: [{ predecessorId: idOf(90), edgeType: 'FS', lagMinutes: 0 }],
          },
        ],
      }),
    );
    // earliest = external block end 10:30; also can't overlap it ⇒ 10:30
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T10:30:00.000Z');
  });
});

describe('unplaceable reasons (DoD)', () => {
  it('done (I8), no_estimate', () => {
    const out = scheduleGreedy(
      input({
        tasks: [
          { id: idOf(1), estimateMinutes: 60, done: true },
          { id: idOf(2), estimateMinutes: 0 },
        ],
      }),
    );
    expect(out.proposals).toEqual([]);
    expect(out.unplaceable).toContainEqual({ taskId: idOf(1), reason: 'done' });
    expect(out.unplaceable).toContainEqual({ taskId: idOf(2), reason: 'no_estimate' });
  });

  it('no_window_fits: estimate exceeds every window, or an unknown window id', () => {
    const tooBig = scheduleGreedy(input({ tasks: [{ id: idOf(1), estimateMinutes: 600 }] }));
    expect(tooBig.unplaceable).toEqual([{ taskId: idOf(1), reason: 'no_window_fits' }]);
    const unknownWindow = scheduleGreedy(
      input({ tasks: [{ id: idOf(2), estimateMinutes: 60, allowedWindowIds: ['evening'] }] }),
    );
    expect(unknownWindow.unplaceable).toEqual([{ taskId: idOf(2), reason: 'no_window_fits' }]);
  });

  it('horizon_full: no free window occurrence remains', () => {
    // one-day horizon whose only morning window is fully anchored, afternoon too
    const committed: CommittedBlock[] = [
      { id: idOf(90), taskId: idOf(90), startsAt: iso('2026-06-15T09:00:00.000Z'), endsAt: iso('2026-06-15T12:00:00.000Z'), anchored: true },
      { id: idOf(91), taskId: idOf(91), startsAt: iso('2026-06-15T13:00:00.000Z'), endsAt: iso('2026-06-15T17:00:00.000Z'), anchored: true },
    ];
    const out = scheduleGreedy(
      input({
        committed,
        horizon: { from: iso('2026-06-15T00:00:00.000Z'), to: iso('2026-06-15T23:00:00.000Z') },
        tasks: [{ id: idOf(1), estimateMinutes: 60 }],
      }),
    );
    expect(out.unplaceable).toEqual([{ taskId: idOf(1), reason: 'horizon_full' }]);
  });

  it('dependency_cycle: a 2-cycle is rejected, both tasks unplaceable', () => {
    const out = scheduleGreedy(
      input({
        tasks: [
          { id: idOf(1), estimateMinutes: 60, dependencies: [{ predecessorId: idOf(2), edgeType: 'FS', lagMinutes: 0 }] },
          { id: idOf(2), estimateMinutes: 60, dependencies: [{ predecessorId: idOf(1), edgeType: 'FS', lagMinutes: 0 }] },
        ],
      }),
    );
    expect(out.proposals).toEqual([]);
    expect(out.unplaceable).toEqual([
      { taskId: idOf(1), reason: 'dependency_cycle' },
      { taskId: idOf(2), reason: 'dependency_cycle' },
    ]);
  });

  it('dependency_unplaceable: a successor of an unplaceable predecessor cannot place', () => {
    const out = scheduleGreedy(
      input({
        tasks: [
          { id: idOf(1), estimateMinutes: 600 }, // no_window_fits
          { id: idOf(2), estimateMinutes: 60, dependencies: [{ predecessorId: idOf(1), edgeType: 'FS', lagMinutes: 0 }] },
        ],
      }),
    );
    expect(out.unplaceable).toContainEqual({ taskId: idOf(1), reason: 'no_window_fits' });
    expect(out.unplaceable).toContainEqual({ taskId: idOf(2), reason: 'dependency_unplaceable' });
  });
});

describe('validWindowsFor — drag hints (§10)', () => {
  it('returns the free regions, clamped past an anchored collision', () => {
    const committed: CommittedBlock[] = [
      { id: idOf(90), taskId: idOf(90), startsAt: iso('2026-06-15T09:00:00.000Z'), endsAt: iso('2026-06-15T10:00:00.000Z'), anchored: true },
    ];
    const regions = validWindowsFor(
      { id: idOf(1), estimateMinutes: 60, allowedWindowIds: ['morning'] },
      input({ committed, tasks: [] }),
    );
    // first morning starts free at 10:00 (after the anchor); later mornings are whole
    expect(isoOf(regions[0]!.start)).toBe('2026-06-15T10:00:00.000Z');
    expect(isoOf(regions[0]!.end)).toBe('2026-06-15T12:00:00.000Z');
    expect(isoOf(regions[1]!.start)).toBe('2026-06-16T09:00:00.000Z');
  });

  it('a done task has no valid windows', () => {
    expect(validWindowsFor({ id: idOf(1), estimateMinutes: 60, done: true }, input({ tasks: [] }))).toEqual([]);
  });
});

describe('rescheduleTask + mode dispatch', () => {
  it('re-places a single past-due task at the earliest fit', () => {
    const result = rescheduleTask(idOf(1), input({ tasks: [{ id: idOf(1), estimateMinutes: 60 }] }));
    expect('startsAt' in result).toBe(true);
    if ('startsAt' in result) expect(isoOf(result.startsAt)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('returns the unplaceable reason when the task cannot be placed', () => {
    const result = rescheduleTask(idOf(1), input({ tasks: [{ id: idOf(1), estimateMinutes: 600 }] }));
    expect(result).toEqual({ taskId: idOf(1), reason: 'no_window_fits' });
  });

  it('notBefore floors the placement', () => {
    const out = scheduleGreedy(
      input({ tasks: [{ id: idOf(1), estimateMinutes: 60, notBefore: iso('2026-06-15T11:00:00.000Z') }] }),
    );
    expect(isoOf(out.proposals[0]!.startsAt)).toBe('2026-06-15T11:00:00.000Z');
  });

  it('schedule() dispatches both greedy and optimize modes', () => {
    expect(schedule(input({ tasks: [{ id: idOf(1), estimateMinutes: 60 }] })).proposals).toHaveLength(1);
    // optimize is implemented in S9: dispatches without throwing, places the task
    const optimized = schedule(input({ tasks: [{ id: idOf(1), estimateMinutes: 60 }], mode: 'optimize' }));
    expect(optimized.proposals).toHaveLength(1);
  });
});

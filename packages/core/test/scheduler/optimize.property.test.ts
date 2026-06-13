/**
 * S9 DoD: the same hard-constraint property suite as greedy must pass for
 * optimize output (never overlaps anchors/itself, never violates dependency
 * order, stays in windows + horizon), plus optimize-specific idempotence:
 * re-optimizing a plan whose committed blocks already are the optimum emits
 * no changes.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { scheduleOptimize } from '../../src/scheduler/optimize';
import type {
  CommittedBlock,
  NamedWindow,
  SchedulableTask,
  SchedulerInput,
} from '../../src/scheduler/types';
import { asEpochMillis, isoToEpochMillis as iso } from '../../src/time/instant';
import { idOf } from '../helpers/fixtures';

const WINDOWS: NamedWindow[] = [
  { id: 'morning', startMinute: 9 * 60, endMinute: 12 * 60 },
  { id: 'afternoon', startMinute: 13 * 60, endMinute: 18 * 60 },
];
const HORIZON = { from: iso('2026-06-15T00:00:00.000Z'), to: iso('2026-06-22T00:00:00.000Z') };
const DAY = 86_400_000;

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

const anchorArb = (seq: number) =>
  fc
    .record({
      dayOffset: fc.integer({ min: 0, max: 6 }),
      startHour: fc.integer({ min: 9, max: 16 }),
      durationH: fc.integer({ min: 1, max: 2 }),
    })
    .map(({ dayOffset, startHour, durationH }): CommittedBlock => {
      const start = HORIZON.from + dayOffset * DAY + startHour * 3_600_000;
      return {
        id: idOf(900 + seq),
        taskId: idOf(900 + seq),
        startsAt: asEpochMillis(start),
        endsAt: asEpochMillis(start + durationH * 3_600_000),
        anchored: true,
      };
    });

const tasksArb = fc.integer({ min: 1, max: 6 }).chain((n) =>
  fc.tuple(
    ...Array.from({ length: n }, (_, i) =>
      fc
        .record({
          estimate: fc.integer({ min: 15, max: 150 }),
          window: fc.option(fc.constantFrom('morning', 'afternoon'), { nil: undefined }),
          dependsOn: i === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: i - 1 }), { nil: null }),
          lag: fc.integer({ min: 0, max: 45 }),
          due: fc.option(fc.constantFrom('2026-06-15', '2026-06-17', '2026-06-20'), { nil: null }),
          sprint: fc.boolean(),
        })
        .map(({ estimate, window, dependsOn, lag, due, sprint }): SchedulableTask => ({
          id: idOf(i),
          estimateMinutes: estimate,
          allowedWindowIds: window ? [window] : undefined,
          dueDate: due,
          sprintMember: sprint,
          dependencies:
            dependsOn === null
              ? undefined
              : [{ predecessorId: idOf(dependsOn), edgeType: 'FS', lagMinutes: lag }],
        })),
    ),
  ),
);

const anchorsArb = fc
  .integer({ min: 0, max: 4 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => anchorArb(i))));

const inputArb: fc.Arbitrary<SchedulerInput> = fc.tuple(tasksArb, anchorsArb).map(([tasks, committed]) => ({
  tasks,
  committed,
  windows: WINDOWS,
  timezone: 'UTC',
  horizon: HORIZON,
  mode: 'optimize' as const,
}));

describe('optimize hard-constraint properties (§10 DoD)', () => {
  it('no proposal overlaps an anchored block, nor another proposal', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const { proposals } = scheduleOptimize(input);
        const blocks = proposals.map((p) => ({ start: p.startsAt, end: p.endsAt }));
        for (const block of blocks) {
          for (const anchor of input.committed) {
            expect(overlaps(block, { start: anchor.startsAt, end: anchor.endsAt })).toBe(false);
          }
        }
        for (let i = 0; i < blocks.length; i += 1) {
          for (let j = i + 1; j < blocks.length; j += 1) {
            expect(overlaps(blocks[i]!, blocks[j]!)).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('respects FS dependency order with lag', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const byId = new Map(scheduleOptimize(input).proposals.map((p) => [p.taskId, p]));
        for (const task of input.tasks) {
          const placed = byId.get(task.id);
          if (!placed) continue;
          for (const dep of task.dependencies ?? []) {
            const pred = byId.get(dep.predecessorId);
            if (!pred) continue;
            expect(placed.startsAt).toBeGreaterThanOrEqual(pred.endsAt + dep.lagMinutes * 60_000);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every proposal lies within an allowed window and the horizon', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        for (const proposal of scheduleOptimize(input).proposals) {
          const task = input.tasks.find((t) => t.id === proposal.taskId)!;
          expect(proposal.startsAt).toBeGreaterThanOrEqual(input.horizon.from);
          expect(proposal.endsAt).toBeLessThanOrEqual(input.horizon.to);
          const dayStart = Math.floor((proposal.startsAt - HORIZON.from) / DAY) * DAY + HORIZON.from;
          const minuteOfDay = (proposal.startsAt - dayStart) / 60_000;
          const endMinuteOfDay = (proposal.endsAt - dayStart) / 60_000;
          const allowed = WINDOWS.filter(
            (w) => !task.allowedWindowIds || task.allowedWindowIds.includes(w.id),
          );
          expect(
            allowed.some((w) => minuteOfDay >= w.startMinute && endMinuteOfDay <= w.endMinute),
          ).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('idempotent: committing the optimum then re-optimizing emits no changes', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const first = scheduleOptimize(input);
        const committedPlus: CommittedBlock[] = [
          ...input.committed,
          ...first.proposals.map((p, i) => ({
            id: idOf(700 + i),
            taskId: p.taskId,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            anchored: false,
          })),
        ];
        const second = scheduleOptimize({ ...input, committed: committedPlus });
        expect(second.proposals).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * M1 — §7.6 scheduler-PLACEMENT constraints (the surface distinct from
 * availability/status and completion). For every edge type + lag, the placed
 * successor block must satisfy:
 *   FS: succ.start >= pred.finish + lag
 *   SS: succ.start >= pred.start  + lag
 *   FF: succ.finish >= pred.finish + lag
 *   SF: succ.finish >= pred.start  + lag
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { EdgeType } from '../../src/domain/entities';
import { scheduleGreedy } from '../../src/scheduler/greedy';
import type { NamedWindow, SchedulableTask, SchedulerInput } from '../../src/scheduler/types';
import { isoToEpochMillis as iso } from '../../src/time/instant';
import { idOf } from '../helpers/fixtures';

const MIN = 60_000;
// one all-day window; a long horizon — placement is driven purely by the edge
// constraint (and pred/succ non-overlap), not by window fragmentation.
const WINDOWS: NamedWindow[] = [{ id: 'allday', startMinute: 0, endMinute: 1440 }];
const HORIZON = { from: iso('2026-06-15T00:00:00.000Z'), to: iso('2026-07-15T00:00:00.000Z') };

function placeTwo(edgeType: EdgeType, lagMinutes: number, predEst: number, succEst: number) {
  const pred: SchedulableTask = { id: idOf(1), estimateMinutes: predEst };
  const succ: SchedulableTask = {
    id: idOf(2),
    estimateMinutes: succEst,
    dependencies: [{ predecessorId: pred.id, edgeType, lagMinutes }],
  };
  const input: SchedulerInput = { tasks: [pred, succ], committed: [], windows: WINDOWS, timezone: 'UTC', horizon: HORIZON, mode: 'greedy' };
  const out = scheduleGreedy(input);
  return {
    p: out.proposals.find((x) => x.taskId === pred.id),
    s: out.proposals.find((x) => x.taskId === succ.id),
  };
}

const satisfies: Record<EdgeType, (p: { startsAt: number; endsAt: number }, s: { startsAt: number; endsAt: number }, lagMs: number) => boolean> = {
  FS: (p, s, lag) => s.startsAt >= p.endsAt + lag,
  SS: (p, s, lag) => s.startsAt >= p.startsAt + lag,
  FF: (p, s, lag) => s.endsAt >= p.endsAt + lag,
  SF: (p, s, lag) => s.endsAt >= p.startsAt + lag,
};

describe('§7.6 placement constraints per edge type', () => {
  for (const edgeType of ['FS', 'SS', 'FF', 'SF'] as const) {
    it(`${edgeType}: the placed successor honors the lower bound (property)`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 300 }),
          fc.integer({ min: 15, max: 120 }),
          fc.integer({ min: 15, max: 120 }),
          (lag, predEst, succEst) => {
            const { p, s } = placeTwo(edgeType, lag, predEst, succEst);
            expect(p, `${edgeType}: pred unplaced`).toBeDefined();
            expect(s, `${edgeType}: succ unplaced`).toBeDefined();
            expect(satisfies[edgeType](p!, s!, lag * MIN), `${edgeType} lag=${lag}`).toBe(true);
          },
        ),
      );
    });
  }

  it('FS with lag places the successor strictly after the predecessor finishes + lag', () => {
    const { p, s } = placeTwo('FS', 30, 60, 45);
    expect(s!.startsAt).toBe(p!.endsAt + 30 * MIN);
  });

  it('SS lets the successor start alongside the predecessor when the lag is zero and they do not overlap', () => {
    // SS lag 0: succ.start >= pred.start; greedy avoids overlap so succ follows pred.
    const { p, s } = placeTwo('SS', 0, 60, 60);
    expect(s!.startsAt).toBeGreaterThanOrEqual(p!.startsAt);
  });
});

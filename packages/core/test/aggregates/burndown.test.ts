/**
 * S6 DoD: burndown scope-change test + incremental === canonical property,
 * plus projection behavior.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalBurndown,
  incrementalBurndown,
  projectFinish,
  type BurndownInputs,
} from '../../src/aggregates/burndown';
import { addDays } from '../../src/time/dates';
import { idOf, makeBlock, makeNode } from '../helpers/fixtures';
import type { Node } from '../../src/domain/entities';

const SETTINGS = { day_reset_hour: 4, timezone: 'America/New_York' };
const RANGE = { from: '2026-06-01', to: '2026-06-10' };

/** Midday New York on `date` ⇒ buckets exactly to `date`. */
const tsOn = (date: string) => `${date}T16:00:00.000Z`;

function task(
  id: number,
  minutes: number | null,
  created: string,
  completed: string | null = null,
  deleted: string | null = null,
): Node {
  return makeNode({
    id: idOf(id),
    node_type: 'task',
    estimate_minutes: minutes,
    created_at: tsOn(created),
    completed_at: completed === null ? null : tsOn(completed),
    deleted_at: deleted === null ? null : tsOn(deleted),
  });
}

describe('burndown series (§7.2)', () => {
  it('DoD scope change: a task created mid-series raises remaining that day', () => {
    const inputs: BurndownInputs = {
      tasks: [task(1, 100, '2026-05-30'), task(2, 50, '2026-06-04')],
      settings: SETTINGS,
      range: RANGE,
    };
    const { days } = canonicalBurndown(inputs);
    expect(days.find((d) => d.date === '2026-06-03')!.remainingMinutes).toBe(100);
    expect(days.find((d) => d.date === '2026-06-04')!.remainingMinutes).toBe(150);
    expect(days.find((d) => d.date === '2026-06-10')!.remainingMinutes).toBe(150);
  });

  it('completions and soft-deletes burn scope down on their bucket day', () => {
    const inputs: BurndownInputs = {
      tasks: [
        task(1, 100, '2026-05-30', '2026-06-05'),
        task(2, 60, '2026-05-30', null, '2026-06-07'),
        task(3, 40, '2026-05-30'),
      ],
      settings: SETTINGS,
      range: RANGE,
    };
    const byDate = Object.fromEntries(
      canonicalBurndown(inputs).days.map((d) => [d.date, d.remainingMinutes]),
    );
    expect(byDate['2026-06-04']).toBe(200);
    expect(byDate['2026-06-05']).toBe(100); // task1 completed
    expect(byDate['2026-06-07']).toBe(40); // task2 deleted
  });

  it('scheduled line sums committed blocks by start bucket; suggested excluded', () => {
    const blocks = [
      makeBlock({
        id: idOf(10),
        task_id: idOf(1),
        starts_at: '2026-06-03T14:00:00.000Z',
        ends_at: '2026-06-03T15:30:00.000Z',
      }),
      makeBlock({
        id: idOf(11),
        task_id: idOf(1),
        starts_at: '2026-06-03T18:00:00.000Z',
        ends_at: '2026-06-03T19:00:00.000Z',
      }),
      makeBlock({
        id: idOf(12),
        task_id: idOf(1),
        starts_at: '2026-06-04T14:00:00.000Z',
        ends_at: '2026-06-04T15:00:00.000Z',
        status: 'suggested',
      }),
    ];
    const { days } = canonicalBurndown({
      tasks: [task(1, 100, '2026-05-30')],
      schedule_blocks: blocks,
      settings: SETTINGS,
      range: RANGE,
    });
    expect(days.find((d) => d.date === '2026-06-03')!.scheduledMinutes).toBe(150);
    expect(days.find((d) => d.date === '2026-06-04')!.scheduledMinutes).toBe(0);
  });

  it('projection: steady burn projects a finish date; flat burn projects none', () => {
    const steady = projectFinish(
      Array.from({ length: 6 }, (_, i) => ({
        date: addDays('2026-06-01', i),
        remainingMinutes: 500 - i * 100,
        scheduledMinutes: 0,
      })),
    );
    // slope −100/day, last remaining 0 at 06-06 → already finished that day
    expect(steady.dailyVelocityMinutes).toBeCloseTo(100, 6);
    expect(steady.projectedFinishDate).toBe('2026-06-06');

    const unfinished = projectFinish(
      Array.from({ length: 6 }, (_, i) => ({
        date: addDays('2026-06-01', i),
        remainingMinutes: 800 - i * 100,
        scheduledMinutes: 0,
      })),
    );
    expect(unfinished.projectedFinishDate).toBe(addDays('2026-06-06', 3));

    const flat = projectFinish(
      Array.from({ length: 6 }, (_, i) => ({
        date: addDays('2026-06-01', i),
        remainingMinutes: 500,
        scheduledMinutes: 0,
      })),
    );
    expect(flat.projectedFinishDate).toBeNull();
    expect(flat.dailyVelocityMinutes).toBe(0);
  });

  it('property: chronological fact folds === canonical', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 40 }),
            minutes: fc.integer({ min: 0, max: 300 }),
            createdDay: fc.integer({ min: 0, max: 9 }),
            completesAfter: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        (specs) => {
          // unique ids, completion day clamped into range
          const seen = new Set<number>();
          const rows: Node[] = [];
          for (const spec of specs) {
            if (seen.has(spec.id)) continue;
            seen.add(spec.id);
            const created = addDays(RANGE.from, spec.createdDay);
            const completed =
              spec.completesAfter === null
                ? null
                : addDays(created, Math.min(spec.completesAfter, 9 - spec.createdDay));
            rows.push(task(spec.id, spec.minutes, created, completed));
          }
          const inputs: BurndownInputs = { tasks: rows, settings: SETTINGS, range: RANGE };

          // fold: introduce each task at creation, then completion, in date order
          type Fact = { date: string; row: Node };
          const facts: Fact[] = [];
          for (const row of rows) {
            const createdDay = row.created_at.slice(0, 10);
            facts.push({ date: createdDay, row: { ...row, completed_at: null } });
            if (row.completed_at !== null) {
              facts.push({ date: row.completed_at.slice(0, 10), row });
            }
          }
          facts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

          const growing: Node[] = [];
          let value = canonicalBurndown({ ...inputs, tasks: [], range: { from: RANGE.from, to: RANGE.from } });
          let currentDay = RANGE.from;
          const upTo = (day: string) => {
            value = canonicalBurndown({
              ...inputs,
              tasks: growing,
              range: { from: RANGE.from, to: day },
            });
            currentDay = day;
          };
          for (const fact of facts) {
            if (fact.date !== currentDay) upTo(fact.date);
            const idx = growing.findIndex((r) => r.id === fact.row.id);
            if (idx === -1) growing.push(fact.row);
            else growing[idx] = fact.row;
            value = incrementalBurndown(value, { kind: 'task', row: fact.row }, {
              ...inputs,
              tasks: growing,
              range: { from: RANGE.from, to: currentDay },
            });
          }
          upTo(RANGE.to);
          const canonical = canonicalBurndown(inputs);
          expect(value.days).toEqual(canonical.days);
          expect(value.projection).toEqual(canonical.projection);
        },
      ),
      { numRuns: 50 },
    );
  });
});

/**
 * S6 DoD: streak goldens per mode across day-reset boundaries, plus the
 * incremental === canonical property over randomized completion streams.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalStreak,
  incrementalStreak,
  type StreakInputs,
} from '../../src/aggregates/streaks';
import { occurrenceDates } from '../../src/aggregates/occurrences';
import { addDays } from '../../src/time/dates';
import { isoToEpochMillis, type Instant } from '../../src/time/instant';
import {
  idOf,
  makeBlock,
  makeEntry,
  makeHabit,
  makeHabitCompletion,
  makeNode,
} from '../helpers/fixtures';
import type { HabitCompletion } from '../../src/domain/entities';

const SETTINGS = { day_reset_hour: 4, timezone: 'America/New_York' };
const VISION = idOf(1);

/** 16:00Z on the given date = midday New York — squarely inside the bucket. */
const at = (date: string): Instant => isoToEpochMillis(`${date}T16:00:00.000Z`);

let completionSeq = 5000;
function completions(habitId: string, dates: readonly string[]): HabitCompletion[] {
  return dates.map((d) =>
    makeHabitCompletion({ id: idOf(++completionSeq), habit_id: habitId, occurrence_date: d }),
  );
}

describe('occurrence engine', () => {
  it('is deterministic and respects dtstart', () => {
    const a = occurrenceDates('FREQ=WEEKLY;BYDAY=MO,FR', '2026-06-01', '2026-06-01', '2026-06-14');
    const b = occurrenceDates('FREQ=WEEKLY;BYDAY=MO,FR', '2026-06-01', '2026-06-01', '2026-06-14');
    expect(a).toEqual(b);
    expect(a).toEqual(['2026-06-01', '2026-06-05', '2026-06-08', '2026-06-12']);
    expect(occurrenceDates('FREQ=DAILY', '2026-06-10', '2026-06-01', '2026-06-12')).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
    expect(() => occurrenceDates('NOT A RULE;;;', '2026-06-01', '2026-06-01', '2026-06-02')).toThrow(
      TypeError,
    );
  });
});

describe('daily streaks across day-reset boundaries (§7.2)', () => {
  const habit = makeHabit({
    id: idOf(100),
    vision_id: VISION,
    rrule: 'FREQ=DAILY',
    created_at: '2026-06-01T12:00:00.000Z',
  });
  const inputs = (dates: string[]): StreakInputs => ({
    habit,
    completions: completions(habit.id, dates),
    settings: SETTINGS,
  });

  it('counts consecutive completed days; today pending does not break', () => {
    const value = canonicalStreak(inputs(['2026-06-09', '2026-06-10', '2026-06-11']), at('2026-06-12'));
    expect(value.current).toBe(3); // today not yet done — streak alive
    expect(value.priorRun).toBe(3);
    const withToday = canonicalStreak(
      inputs(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12']),
      at('2026-06-12'),
    );
    expect(withToday.current).toBe(4);
  });

  it('a missed past day breaks the run; longest remembers the best run', () => {
    const value = canonicalStreak(
      inputs(['2026-06-05', '2026-06-06', '2026-06-07', /* 08 missed */ '2026-06-09', '2026-06-10']),
      at('2026-06-10'),
    );
    expect(value.current).toBe(2);
    expect(value.longest).toBe(3);
  });

  it("day-reset: at 3am local the bucket is still yesterday, so yesterday's completion keeps today's streak", () => {
    // 2026-06-12T07:00Z = 03:00 New York (reset 4) ⇒ bucket 2026-06-11
    const beforeReset = isoToEpochMillis('2026-06-12T07:00:00.000Z');
    const value = canonicalStreak(inputs(['2026-06-10', '2026-06-11']), beforeReset);
    expect(value.current).toBe(2);
    // one hour later (04:30 local) the day flips and 06-12 is now pending
    const afterReset = isoToEpochMillis('2026-06-12T08:30:00.000Z');
    expect(canonicalStreak(inputs(['2026-06-10', '2026-06-11']), afterReset).current).toBe(2);
    // …and a missing 06-11 NOW breaks once the bucket has moved past it
    expect(canonicalStreak(inputs(['2026-06-10']), afterReset).current).toBe(0);
  });

  it('non-scheduled days are skipped, not broken (MO/WE/FR rule)', () => {
    const mwf = makeHabit({
      id: idOf(101),
      vision_id: VISION,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      created_at: '2026-06-01T12:00:00.000Z',
    });
    // Mon 06-08, Wed 06-10, Fri 06-12 — completed Mon+Wed, asked on Thu 06-11
    const value = canonicalStreak(
      { habit: mwf, completions: completions(mwf.id, ['2026-06-08', '2026-06-10']), settings: SETTINGS },
      at('2026-06-11'),
    );
    expect(value.current).toBe(2); // Tue/Thu don't break
  });
});

describe('weekly/monthly/quarterly/yearly periods', () => {
  it('weekly: every occurrence in the Mon-start week must be complete', () => {
    const habit = makeHabit({
      id: idOf(102),
      vision_id: VISION,
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      streak_mode: 'weekly',
      created_at: '2026-05-04T12:00:00.000Z',
    });
    // weeks of 06-01 and 06-08 fully done; current week (06-15) pending
    const done = ['2026-06-02', '2026-06-04', '2026-06-09', '2026-06-11'];
    const value = canonicalStreak(
      { habit, completions: completions(habit.id, done), settings: SETTINGS },
      at('2026-06-16'), // Tuesday of week 3
    );
    expect(value.current).toBe(2);
    // half-done past week breaks
    const half = canonicalStreak(
      { habit, completions: completions(habit.id, ['2026-06-02', '2026-06-09', '2026-06-11']), settings: SETTINGS },
      at('2026-06-16'),
    );
    expect(half.current).toBe(1);
  });

  it('monthly, quarterly, yearly buckets', () => {
    const monthly = makeHabit({
      id: idOf(103),
      vision_id: VISION,
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      streak_mode: 'monthly',
      created_at: '2026-01-01T12:00:00.000Z',
    });
    const value = canonicalStreak(
      {
        habit: monthly,
        completions: completions(monthly.id, ['2026-03-15', '2026-04-15', '2026-05-15']),
        settings: SETTINGS,
      },
      at('2026-06-10'), // June's 15th not due yet
    );
    expect(value.current).toBe(3);

    const quarterly = makeHabit({
      id: idOf(104),
      vision_id: VISION,
      rrule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1',
      streak_mode: 'quarterly',
      created_at: '2025-10-01T12:00:00.000Z',
    });
    const qValue = canonicalStreak(
      {
        habit: quarterly,
        completions: completions(quarterly.id, ['2026-01-01', '2026-04-01']),
        settings: SETTINGS,
      },
      at('2026-06-12'),
    );
    expect(qValue.current).toBe(2);

    const yearly = makeHabit({
      id: idOf(105),
      vision_id: VISION,
      rrule: 'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1',
      streak_mode: 'yearly',
      created_at: '2024-01-01T12:00:00.000Z',
    });
    const yValue = canonicalStreak(
      {
        habit: yearly,
        completions: completions(yearly.id, ['2024-06-01', '2025-06-01', '2026-06-01']),
        settings: SETTINGS,
      },
      at('2026-06-12'),
    );
    expect(yValue.current).toBe(3);
  });
});

describe('perfect_planned (§7.2: every scheduled block needs a session)', () => {
  const habit = makeHabit({
    id: idOf(110),
    vision_id: VISION,
    rrule: 'FREQ=DAILY',
    streak_mode: 'perfect_planned',
    created_at: '2026-06-08T12:00:00.000Z',
  });
  const task = makeNode({ id: idOf(111), node_type: 'task', habit_id: habit.id });
  const block = makeBlock({
    id: idOf(112),
    task_id: task.id,
    starts_at: '2026-06-10T14:00:00.000Z',
    ends_at: '2026-06-10T15:00:00.000Z',
  });
  const base = {
    habit,
    nodes: [task],
    settings: SETTINGS,
    completions: completions(habit.id, ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11']),
  };

  it('a past block without an overlapping session breaks the run even when checked off', () => {
    const value = canonicalStreak(
      { ...base, schedule_blocks: [block], time_entries: [] },
      at('2026-06-12'),
    );
    expect(value.current).toBe(1); // broken on 06-10; 06-11 restarts the run
    expect(value.longest).toBe(2); // 06-08..06-09
  });

  it('an overlapping session on the block keeps the streak perfect', () => {
    const session = makeEntry({
      id: idOf(113),
      task_id: task.id,
      started_at: '2026-06-10T14:20:00.000Z',
      ended_at: '2026-06-10T14:50:00.000Z',
    });
    const value = canonicalStreak(
      { ...base, schedule_blocks: [block], time_entries: [session] },
      at('2026-06-12'),
    );
    expect(value.current).toBe(4);
  });

  it("today's blocks are pending, suggested blocks don't count", () => {
    const todayBlock = makeBlock({
      id: idOf(114),
      task_id: task.id,
      starts_at: '2026-06-12T20:00:00.000Z',
      ends_at: '2026-06-12T21:00:00.000Z',
    });
    const suggested = makeBlock({
      id: idOf(115),
      task_id: task.id,
      starts_at: '2026-06-09T14:00:00.000Z',
      ends_at: '2026-06-09T15:00:00.000Z',
      status: 'suggested',
    });
    const value = canonicalStreak(
      { ...base, schedule_blocks: [todayBlock, suggested], time_entries: [] },
      at('2026-06-12'),
    );
    expect(value.current).toBe(4);
  });
});

describe('incremental === canonical (DoD property)', () => {
  it('chronological completion streams fold to the canonical value', () => {
    const habit = makeHabit({
      id: idOf(120),
      vision_id: VISION,
      rrule: 'FREQ=DAILY',
      created_at: '2026-06-01T12:00:00.000Z',
    });
    const window = Array.from({ length: 12 }, (_, i) => addDays('2026-06-01', i));
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 11 }), { minLength: 0, maxLength: 12 }),
        (picked) => {
          const dates = picked.sort((a, b) => a - b).map((i) => window[i]!);
          const all = completions(habit.id, dates);
          // fold chronologically: value computed before each fact arrives
          let value = canonicalStreak(
            { habit, completions: [], settings: SETTINGS },
            at('2026-06-12'),
          );
          const seen: HabitCompletion[] = [];
          for (const completion of all) {
            seen.push(completion);
            value = incrementalStreak(
              value,
              completion,
              { habit, completions: seen, settings: SETTINGS },
              at('2026-06-12'),
            );
          }
          const canonical = canonicalStreak(
            { habit, completions: all, settings: SETTINGS },
            at('2026-06-12'),
          );
          expect(value).toEqual(canonical);
        },
      ),
    );
  });

  it('fast path: a same-day completion bumps the streak without recompute drift', () => {
    const habit = makeHabit({
      id: idOf(121),
      vision_id: VISION,
      rrule: 'FREQ=DAILY',
      created_at: '2026-06-08T12:00:00.000Z',
    });
    const prior = completions(habit.id, ['2026-06-10', '2026-06-11']);
    const prev = canonicalStreak({ habit, completions: prior, settings: SETTINGS }, at('2026-06-12'));
    expect(prev.current).toBe(2);
    const todays = completions(habit.id, ['2026-06-12'])[0]!;
    const next = incrementalStreak(
      prev,
      todays,
      { habit, completions: [...prior, todays], settings: SETTINGS },
      at('2026-06-12'),
    );
    expect(next.current).toBe(3);
    expect(next.longest).toBe(3);
  });
});

/**
 * Streaks (§7.2): evaluate habit rrule occurrences against habit_completions
 * per streak_mode; `perfect_planned` additionally requires every committed
 * scheduled block of the habit's tasks in the period to have an overlapping
 * time-entry session.
 *
 * Normative interpretations (the spec names the modes; these pin semantics):
 * - The streak unit is the mode's calendar period (daily/perfect_planned →
 *   day; weekly → Mon-start week; monthly; quarterly → Jan/Apr/Jul/Oct;
 *   yearly). Periods are civil dates; completions carry already-bucketed
 *   occurrence_dates (§6.0), and "today" comes from bucketDate(now) — so the
 *   day-reset hour shifts every boundary consistently.
 * - A period is SATISFIED when it has ≥1 rrule occurrence and every
 *   occurrence has a completion; a period with no occurrences is skipped
 *   (neither counts nor breaks).
 * - The current (incomplete) period is pending: occurrences today or later
 *   never break it; it joins the streak as soon as its due occurrences are
 *   all completed (and at least one is).
 * - perfect_planned: a day is violated when any committed block of the
 *   habit's tasks (bucketed by starts_at) lacks an overlapping entry of the
 *   same task; violated days break the run even when the check-off exists.
 *
 * The stored value carries `priorRun` (run excluding the current period) so
 * the incremental form can fold a same-period completion in O(period).
 */
import type {
  Habit,
  HabitCompletion,
  Node,
  ScheduleBlock,
  TimeEntry,
} from '../domain/entities';
import type { IsoDate } from '../domain/primitives';
import { bucketDate } from '../time/bucket';
import { monthStart, quarterStart, weekStart, yearStart } from '../time/dates';
import { isoToEpochMillis, type Instant } from '../time/instant';

import { habitTaskIds } from './practice';
import { occurrenceDates } from './occurrences';

export interface StreakValue {
  current: number;
  longest: number;
  /** Run length excluding the current period (incremental fast path). */
  priorRun: number;
  /** The day bucket this value was computed for. */
  computedThrough: IsoDate;
}

export interface StreakSettings {
  day_reset_hour: number;
  timezone: string;
}

export interface StreakInputs {
  habit: Habit;
  completions: readonly HabitCompletion[];
  /** Needed for perfect_planned; harmless otherwise. */
  nodes?: readonly Node[];
  schedule_blocks?: readonly ScheduleBlock[];
  time_entries?: readonly TimeEntry[];
  settings: StreakSettings;
}

export function periodStart(date: IsoDate, mode: Habit['streak_mode']): IsoDate {
  switch (mode) {
    case 'perfect_planned':
    case 'daily':
      return date;
    case 'weekly':
      return weekStart(date);
    case 'monthly':
      return monthStart(date);
    case 'quarterly':
      return quarterStart(date);
    case 'yearly':
      return yearStart(date);
  }
}

/** The habit's anchor date: occurrences exist from creation onward. */
export function habitStartDate(habit: Habit, settings: StreakSettings): IsoDate {
  return bucketDate(
    isoToEpochMillis(habit.created_at),
    settings.day_reset_hour,
    settings.timezone,
  );
}

interface DayFacts {
  completed: ReadonlySet<IsoDate>;
  violatedDays: ReadonlySet<IsoDate>;
}

function collectDayFacts(inputs: StreakInputs, today: IsoDate): DayFacts {
  const completed = new Set<IsoDate>();
  for (const completion of inputs.completions) {
    if (completion.deleted_at !== null) continue;
    if (completion.habit_id !== inputs.habit.id) continue;
    completed.add(completion.occurrence_date);
  }

  const violatedDays = new Set<IsoDate>();
  if (inputs.habit.streak_mode === 'perfect_planned') {
    const tasks = habitTaskIds(inputs.habit, inputs.nodes ?? []);
    const entriesByTask = new Map<string, TimeEntry[]>();
    for (const entry of inputs.time_entries ?? []) {
      if (entry.deleted_at !== null || !tasks.has(entry.task_id)) continue;
      const list = entriesByTask.get(entry.task_id);
      if (list) list.push(entry);
      else entriesByTask.set(entry.task_id, [entry]);
    }
    for (const block of inputs.schedule_blocks ?? []) {
      if (block.deleted_at !== null || block.status !== 'committed') continue;
      if (!tasks.has(block.task_id)) continue;
      const day = bucketDate(
        isoToEpochMillis(block.starts_at),
        inputs.settings.day_reset_hour,
        inputs.settings.timezone,
      );
      if (day >= today) continue; // pending until the day has passed
      const blockStart = isoToEpochMillis(block.starts_at);
      const blockEnd = isoToEpochMillis(block.ends_at);
      const hasSession = (entriesByTask.get(block.task_id) ?? []).some((entry) => {
        const start = isoToEpochMillis(entry.started_at);
        const end = entry.ended_at === null ? Infinity : isoToEpochMillis(entry.ended_at);
        return start < blockEnd && end > blockStart;
      });
      if (!hasSession) violatedDays.add(day);
    }
  }

  return { completed, violatedDays };
}

function computeStreak(inputs: StreakInputs, today: IsoDate): StreakValue {
  const { habit } = inputs;
  const mode = habit.streak_mode;
  const start = habitStartDate(habit, inputs.settings);
  const facts = collectDayFacts(inputs, today);

  if (today < start) {
    return { current: 0, longest: 0, priorRun: 0, computedThrough: today };
  }

  const occurrences = occurrenceDates(habit.rrule, start, start, today);

  // Group occurrences (and violated days) into periods, in chronological order.
  interface PeriodState {
    start: IsoDate;
    due: number; // occurrences ≤ today (strictly past, or today itself)
    missed: boolean;
    completedCount: number;
  }
  const periods = new Map<IsoDate, PeriodState>();
  const periodOrder: IsoDate[] = [];
  const periodFor = (date: IsoDate): PeriodState => {
    const key = periodStart(date, mode);
    let state = periods.get(key);
    if (!state) {
      state = { start: key, due: 0, missed: false, completedCount: 0 };
      periods.set(key, state);
      periodOrder.push(key);
    }
    return state;
  };

  for (const occurrence of occurrences) {
    const state = periodFor(occurrence);
    state.due += 1;
    if (facts.completed.has(occurrence)) {
      state.completedCount += 1;
    } else if (occurrence < today) {
      state.missed = true; // strictly past and incomplete breaks
    }
    // an occurrence today without a completion is pending, not missed
  }
  for (const violated of facts.violatedDays) {
    if (violated >= start) periodFor(violated).missed = true;
  }
  periodOrder.sort();

  const currentPeriodStart = periodStart(today, mode);
  let longest = 0;
  let run = 0;
  let priorRun = 0;
  let current = 0;

  for (const key of periodOrder) {
    const state = periods.get(key)!;
    const isCurrent = key === currentPeriodStart;
    if (isCurrent) priorRun = run;
    const satisfied = !state.missed && state.completedCount > 0 && state.completedCount >= state.due;
    if (state.missed) {
      run = 0;
    } else if (satisfied) {
      run += 1;
    } else if (!isCurrent && state.due > 0) {
      // a past period with unfinished occurrences breaks the run
      run = 0;
    }
    // current period with pending occurrences leaves `run` untouched
    if (run > longest) longest = run;
    if (isCurrent) current = run;
  }

  // No occurrences recorded in the current period at all → streak continues
  // from the last evaluated period.
  if (!periods.has(currentPeriodStart)) {
    priorRun = run;
    current = run;
  }

  return { current, longest, priorRun, computedThrough: today };
}

export function canonicalStreak(inputs: StreakInputs, now: Instant): StreakValue {
  const today = bucketDate(now, inputs.settings.day_reset_hour, inputs.settings.timezone);
  return computeStreak(inputs, today);
}

/**
 * Folds one new completion. Fast path: the completion lands in the current
 * period of an up-to-date value — only that period is re-evaluated. Anything
 * else (day rolled over, backdated completion) falls back to canonical.
 */
export function incrementalStreak(
  prev: StreakValue,
  completion: HabitCompletion,
  inputs: StreakInputs,
  now: Instant,
): StreakValue {
  const today = bucketDate(now, inputs.settings.day_reset_hour, inputs.settings.timezone);
  const mode = inputs.habit.streak_mode;
  if (
    prev.computedThrough !== today ||
    completion.habit_id !== inputs.habit.id ||
    completion.deleted_at !== null ||
    periodStart(completion.occurrence_date, mode) !== periodStart(today, mode)
  ) {
    return canonicalStreak(inputs, now);
  }

  // Re-evaluate just the current period against the full local fact set
  // (which already contains the new completion on the client).
  const start = habitStartDate(inputs.habit, inputs.settings);
  const currentStart = periodStart(today, mode);
  const facts = collectDayFacts(inputs, today);
  const occurrences = occurrenceDates(
    inputs.habit.rrule,
    start,
    currentStart < start ? start : currentStart,
    today,
  );
  let due = 0;
  let completedCount = 0;
  let missed = false;
  for (const occurrence of occurrences) {
    due += 1;
    if (facts.completed.has(occurrence)) completedCount += 1;
    else if (occurrence < today) missed = true;
  }
  for (const violated of facts.violatedDays) {
    if (violated >= currentStart) missed = true;
  }

  const satisfied = !missed && completedCount > 0 && completedCount >= due;
  const current = missed ? 0 : prev.priorRun + (satisfied ? 1 : 0);
  return {
    current,
    longest: Math.max(prev.longest, current),
    priorRun: prev.priorRun,
    computedThrough: today,
  };
}

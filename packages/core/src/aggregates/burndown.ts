/**
 * Burndown + projection (§7.2): daily series of remaining estimate minutes
 * (scope changes included — tasks enter the series at their creation bucket
 * and leave at their deletion bucket) vs. the scheduled line (committed block
 * minutes per day). Projection: least-squares slope over the trailing ≤14
 * remaining-points → projected finish date; this IS the simple linear
 * estimate clients fall back to, and the server may upgrade independently
 * (principle 5).
 *
 * Estimates are read from current rows (estimate edits are not historically
 * tracked); minutes use estimate_minutes ?? 0 — burndown is a minutes chart,
 * unlike completion % which weights estimate-less tasks as 1.
 */
import type { Node, ScheduleBlock } from '../domain/entities';
import type { IsoDate } from '../domain/primitives';
import { bucketDate } from '../time/bucket';
import { addDays, daysBetween } from '../time/dates';
import { minutesBetween } from '../time/duration';
import { isoToEpochMillis } from '../time/instant';

export interface BurndownDay {
  date: IsoDate;
  remainingMinutes: number;
  scheduledMinutes: number;
}

export interface BurndownProjection {
  /** null when velocity is flat/negative or the series is too short. */
  projectedFinishDate: IsoDate | null;
  /** Positive = burning down, minutes per day. */
  dailyVelocityMinutes: number;
}

export interface BurndownValue {
  days: BurndownDay[];
  projection: BurndownProjection;
}

export interface BurndownSettings {
  day_reset_hour: number;
  timezone: string;
}

export interface BurndownInputs {
  /** The task set in scope (e.g. a project's descendant tasks). */
  tasks: readonly Node[];
  schedule_blocks?: readonly ScheduleBlock[];
  settings: BurndownSettings;
  range: { from: IsoDate; to: IsoDate };
}

const bucketOf = (iso: string, settings: BurndownSettings): IsoDate =>
  bucketDate(isoToEpochMillis(iso), settings.day_reset_hour, settings.timezone);

/** Trailing-window least squares over remaining minutes. */
export function projectFinish(days: readonly BurndownDay[]): BurndownProjection {
  const window = days.slice(-14);
  if (window.length < 2) {
    return { projectedFinishDate: null, dailyVelocityMinutes: 0 };
  }
  const n = window.length;
  const meanX = (n - 1) / 2;
  const meanY = window.reduce((sum, d) => sum + d.remainingMinutes, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (window[i]!.remainingMinutes - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = num / den; // minutes per day
  const last = window[n - 1]!;
  if (slope >= 0 || last.remainingMinutes <= 0) {
    return {
      projectedFinishDate: last.remainingMinutes <= 0 ? last.date : null,
      dailyVelocityMinutes: Math.max(0, -slope),
    };
  }
  const daysToZero = Math.ceil(last.remainingMinutes / -slope);
  return {
    projectedFinishDate: addDays(last.date, daysToZero),
    dailyVelocityMinutes: -slope,
  };
}

export function canonicalBurndown(inputs: BurndownInputs): BurndownValue {
  const { settings, range } = inputs;
  const length = daysBetween(range.from, range.to) + 1;
  if (length <= 0) {
    return { days: [], projection: { projectedFinishDate: null, dailyVelocityMinutes: 0 } };
  }

  interface TaskWindow {
    created: IsoDate;
    completed: IsoDate | null;
    deleted: IsoDate | null;
    minutes: number;
  }
  const windows: TaskWindow[] = [];
  for (const task of inputs.tasks) {
    if (task.node_type !== 'task') continue;
    windows.push({
      created: bucketOf(task.created_at, settings),
      completed: task.completed_at === null ? null : bucketOf(task.completed_at, settings),
      deleted: task.deleted_at === null ? null : bucketOf(task.deleted_at, settings),
      minutes: task.estimate_minutes ?? 0,
    });
  }

  const scheduled = new Map<IsoDate, number>();
  for (const block of inputs.schedule_blocks ?? []) {
    if (block.deleted_at !== null || block.status !== 'committed') continue;
    const day = bucketOf(block.starts_at, settings);
    scheduled.set(
      day,
      (scheduled.get(day) ?? 0) +
        Math.max(0, minutesBetween(block.starts_at, block.ends_at)),
    );
  }

  const days: BurndownDay[] = [];
  for (let i = 0; i < length; i += 1) {
    const date = addDays(range.from, i);
    let remaining = 0;
    for (const w of windows) {
      if (w.created > date) continue; // not yet in scope
      if (w.deleted !== null && w.deleted <= date) continue; // left scope
      if (w.completed !== null && w.completed <= date) continue; // done or obsolete (both scope-out via completed_at)
      remaining += w.minutes;
    }
    days.push({
      date,
      remainingMinutes: remaining,
      scheduledMinutes: scheduled.get(date) ?? 0,
    });
  }

  return { days, projection: projectFinish(days) };
}

/**
 * Folds one changed row. Fast path: every bucket the row touches is the
 * series' last day — patch that point and re-project. Anything reaching
 * earlier days falls back to canonical.
 */
export function incrementalBurndown(
  prev: BurndownValue,
  fact: { kind: 'task'; row: Node } | { kind: 'block'; row: ScheduleBlock },
  inputs: BurndownInputs,
): BurndownValue {
  const last = prev.days.at(-1);
  if (!last) return canonicalBurndown(inputs);
  const { settings } = inputs;

  if (fact.kind === 'block') {
    const block = fact.row;
    if (block.deleted_at !== null || block.status !== 'committed') {
      return canonicalBurndown(inputs);
    }
    if (bucketOf(block.starts_at, settings) !== last.date) return canonicalBurndown(inputs);
    const days = [...prev.days.slice(0, -1), {
      ...last,
      scheduledMinutes:
        last.scheduledMinutes + Math.max(0, minutesBetween(block.starts_at, block.ends_at)),
    }];
    return { days, projection: projectFinish(days) };
  }

  const task = fact.row;
  if (task.node_type !== 'task') return prev;
  const touched: IsoDate[] = [bucketOf(task.created_at, settings)];
  if (task.completed_at !== null) touched.push(bucketOf(task.completed_at, settings));
  if (task.deleted_at !== null) touched.push(bucketOf(task.deleted_at, settings));
  const minutes = task.estimate_minutes ?? 0;

  // newly created today (still open) → +scope; completed/deleted today → −scope
  if (touched.every((d) => d === last.date)) {
    const delta =
      task.completed_at === null && task.deleted_at === null ? minutes : 0;
    const days = [...prev.days.slice(0, -1), {
      ...last,
      remainingMinutes: last.remainingMinutes + delta,
    }];
    return { days, projection: projectFinish(days) };
  }
  if (
    (task.completed_at !== null && bucketOf(task.completed_at, settings) === last.date) ||
    (task.deleted_at !== null && bucketOf(task.deleted_at, settings) === last.date)
  ) {
    const days = [...prev.days.slice(0, -1), {
      ...last,
      remainingMinutes: Math.max(0, last.remainingMinutes - minutes),
    }];
    return { days, projection: projectFinish(days) };
  }
  return canonicalBurndown(inputs);
}

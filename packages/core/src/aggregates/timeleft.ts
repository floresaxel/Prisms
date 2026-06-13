/**
 * Time-left trio (§7.2): instantaneous display math — minutes left in the
 * user's day (next day-reset − now), in a task (estimate − consumed), and
 * until the next committed block. Pure functions of `now`; they need no
 * incremental/canonical split because they aggregate nothing.
 */
import type { Node, ScheduleBlock, TimeEntry } from '../domain/entities';
import { bucketDate, localInstant } from '../time/bucket';
import { addDays } from '../time/dates';
import { msToMinutes } from '../time/duration';
import { isoToEpochMillis, type EpochMillis, type Instant } from '../time/instant';

import { canonicalProgress } from './progress';

export interface DaySettings {
  day_reset_hour: number;
  timezone: string;
}

/** The instant of the next day-reset after `now`. */
export function nextDayReset(now: Instant, settings: DaySettings): EpochMillis {
  const today = bucketDate(now, settings.day_reset_hour, settings.timezone);
  return localInstant(addDays(today, 1), settings.day_reset_hour, settings.timezone);
}

export function minutesLeftInDay(now: Instant, settings: DaySettings): number {
  return msToMinutes(nextDayReset(now, settings) - now);
}

/** estimate − consumed raw minutes; negative when over; null without estimate. */
export function minutesLeftInTask(task: Node, entries: readonly TimeEntry[]): number | null {
  if (task.estimate_minutes === null) return null;
  return task.estimate_minutes - canonicalProgress(task, entries).consumedMinutes;
}

/**
 * Minutes until the next committed block starting after `now` (optionally for
 * one task); null when nothing is scheduled ahead.
 */
export function minutesUntilNextBlock(
  blocks: readonly ScheduleBlock[],
  now: Instant,
  taskId?: string,
): number | null {
  let nextStart: number | null = null;
  for (const block of blocks) {
    if (block.deleted_at !== null || block.status !== 'committed') continue;
    if (taskId !== undefined && block.task_id !== taskId) continue;
    const start = isoToEpochMillis(block.starts_at);
    if (start <= now) continue;
    if (nextStart === null || start < nextStart) nextStart = start;
  }
  return nextStart === null ? null : msToMinutes(nextStart - now);
}

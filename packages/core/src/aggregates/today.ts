/**
 * Habit "today" minutes for the daily-target ring (§7.2 display, §9.2):
 * entries in today's bucket union PER TASK via `mergeTimeEntries` (§7.10b —
 * two overlapping offline sessions count once, audit S3-F2). A still-running
 * entry counts up to `nowMs` (display-only; open entries are not aggregate
 * facts). Under split focus each span is credited its share of whatever else
 * was running (`splitConcurrent`), running timers included. PURE (§16):
 * `nowMs` is a parameter, never a wall-clock read.
 */
import type { TimeEntry } from '../domain/entities';
import type { IsoDate, Uuid } from '../domain/primitives';
import { splitConcurrent } from '../merge/split-focus';
import { mergeTimeEntries } from '../merge/time-entries';
import { bucketDate } from '../time/bucket';

export function habitTodayMinutes(
  entries: readonly TimeEntry[],
  taskIds: ReadonlySet<Uuid>,
  today: IsoDate,
  dayResetHour: number,
  timeZone: string,
  nowMs: number,
): number {
  const byTask = new Map<Uuid, TimeEntry[]>();
  for (const e of splitConcurrent(entries, nowMs)) {
    if (!taskIds.has(e.task_id)) continue;
    if (bucketDate(e.started_at, dayResetHour, timeZone) !== today) continue;
    const list = byTask.get(e.task_id);
    if (list === undefined) byTask.set(e.task_id, [e]);
    else list.push(e);
  }
  let minutes = 0;
  for (const list of byTask.values()) minutes += mergeTimeEntries(list).rawMinutes;
  return minutes;
}

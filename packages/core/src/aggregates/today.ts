/**
 * Habit "today" minutes for the daily-target ring (§7.2 display, §9.2):
 * closed entries in today's bucket union PER TASK via `mergeTimeEntries`
 * (§7.10b — two overlapping offline sessions count once, audit S3-F2);
 * a still-running entry adds live elapsed time on top (display-only; open
 * entries are not aggregate facts). PURE (§16): `nowMs` is a parameter,
 * never a wall-clock read.
 */
import type { TimeEntry } from '../domain/entities';
import type { IsoDate, Uuid } from '../domain/primitives';
import { mergeTimeEntries } from '../merge/time-entries';
import { bucketDate } from '../time/bucket';
import { isoToEpochMillis } from '../time/instant';

export function habitTodayMinutes(
  entries: readonly TimeEntry[],
  taskIds: ReadonlySet<Uuid>,
  today: IsoDate,
  dayResetHour: number,
  timeZone: string,
  nowMs: number,
): number {
  const byTask = new Map<Uuid, TimeEntry[]>();
  let minutes = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || !taskIds.has(e.task_id)) continue;
    if (bucketDate(e.started_at, dayResetHour, timeZone) !== today) continue;
    if (e.ended_at === null) {
      minutes += Math.max(0, (nowMs - isoToEpochMillis(e.started_at)) / 60_000);
    } else {
      const list = byTask.get(e.task_id);
      if (list === undefined) byTask.set(e.task_id, [e]);
      else list.push(e);
    }
  }
  for (const list of byTask.values()) minutes += mergeTimeEntries(list).rawMinutes;
  return minutes;
}

/**
 * Effective time (§7.2): `effectiveHours(entry) = (ended_at − started_at) ×
 * focus_factor (default 1.0)`.
 *
 * Only closed entries are facts; an open (running) entry contributes nothing
 * until clock-out (live elapsed display is a UI concern, not an aggregate).
 * Raw minutes (no focus factor) feed the task progress bar.
 */
import type { TimeEntry } from '../domain/entities';
import { minutesBetween } from '../time/duration';

export function rawMinutes(entry: TimeEntry): number {
  if (entry.ended_at === null) return 0;
  return Math.max(0, minutesBetween(entry.started_at, entry.ended_at));
}

export function effectiveMinutes(entry: TimeEntry): number {
  return rawMinutes(entry) * (entry.focus_factor ?? 1.0);
}

export function effectiveHours(entry: TimeEntry): number {
  return effectiveMinutes(entry) / 60;
}

/**
 * Duration math (§7.2). The database speaks minutes (estimate_minutes,
 * lag_minutes, daily_target_minutes); instants are epoch ms.
 */
import type { IsoDateTime } from '../domain/primitives';
import { asEpochMillis, toEpochMillis, type EpochMillis } from './instant';

export const MS_PER_MINUTE = 60_000;

export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

export function msToMinutes(ms: number): number {
  return ms / MS_PER_MINUTE;
}

/** `addMinutes(p.completed_at, e.lag_minutes)` in the status function (§7.1). */
export function addMinutes(
  ts: EpochMillis | IsoDateTime,
  minutes: number,
): EpochMillis {
  return asEpochMillis(toEpochMillis(ts) + Math.round(minutesToMs(minutes)));
}

/** Exact (possibly fractional, possibly negative) minutes from start to end. */
export function minutesBetween(
  start: EpochMillis | IsoDateTime,
  end: EpochMillis | IsoDateTime,
): number {
  return msToMinutes(toEpochMillis(end) - toEpochMillis(start));
}

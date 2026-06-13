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

const ISO_DURATION_REGEX =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Calendar-free ISO-8601 duration (weeks/days/hours/minutes/seconds — no
 * months/years, which have no fixed length) to milliseconds. Returns null on
 * anything else; '9.3 trigger-relative dates' parse with this.
 */
export function parseIsoDurationMs(text: string): number | null {
  const match = ISO_DURATION_REGEX.exec(text);
  if (!match || text === 'P' || text === 'PT') return null;
  const [, weeks, days, hours, minutes, seconds] = match;
  if (!weeks && !days && !hours && !minutes && !seconds) return null;
  return (
    Number(weeks ?? 0) * 7 * 24 * 3_600_000 +
    Number(days ?? 0) * 24 * 3_600_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000
  );
}

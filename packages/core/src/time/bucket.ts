/**
 * Day bucketing (ARCHITECTURE.md §7.2): `bucketDate(ts) = date(ts − day_reset_hour)`
 * in the user's timezone. Every "today/daily" computation MUST go through this.
 *
 * Semantics: the user's day flips at exactly `day_reset_hour:00` LOCAL WALL
 * TIME. We read the instant's wall-clock components in the user's zone; if
 * the local hour is `>= day_reset_hour` the bucket is that local date,
 * otherwise the previous calendar date. Interpreting the spec formula in
 * wall time (rather than subtracting absolute hours from the instant) keeps
 * the boundary at 04:00 local even on DST transition days, where an
 * absolute-time subtraction would shift it by the DST delta.
 *
 * Uses Intl (ECMA-402) for IANA timezone data — available on Node ≥ 20,
 * evergreen browsers, and Hermes; deterministic for a given instant/zone.
 */
import type { IsoDate, IsoDateTime } from '../domain/primitives';
import { toEpochMillis, type EpochMillis } from './instant';

const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // Throws RangeError for unknown zones — a contract violation, not a domain error.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function localParts(ms: EpochMillis, timeZone: string): LocalParts {
  const parts = tzFormatter(timeZone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new TypeError(`bucketDate: missing "${type}" part`);
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
  };
}

function formatDate(year: number, month: number, day: number): IsoDate {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function bucketDate(
  ts: EpochMillis | IsoDateTime,
  dayResetHour: number,
  timeZone: string,
): IsoDate {
  if (!Number.isInteger(dayResetHour) || dayResetHour < 0 || dayResetHour > 23) {
    throw new TypeError(
      `bucketDate: dayResetHour must be an integer in [0, 23], got ${dayResetHour}`,
    );
  }
  const { year, month, day, hour } = localParts(toEpochMillis(ts), timeZone);
  if (hour >= dayResetHour) {
    return formatDate(year, month, day);
  }
  // Before the reset hour: the instant still belongs to the previous local
  // calendar date. Pure date arithmetic via Date.UTC (no zone involved).
  const previous = new Date(Date.UTC(year, month - 1, day) - MS_PER_DAY);
  return formatDate(
    previous.getUTCFullYear(),
    previous.getUTCMonth() + 1,
    previous.getUTCDate(),
  );
}

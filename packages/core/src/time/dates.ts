/**
 * Pure civil-date helpers over 'YYYY-MM-DD' strings.
 *
 * All arithmetic happens on UTC components of synthetic Date objects — no
 * timezone is involved (zone-aware math lives in bucket.ts). ISO date strings
 * compare chronologically with plain `<`/`>`.
 */
import type { IsoDate } from '../domain/primitives';

const MS_PER_DAY = 86_400_000;

export function isoDateToUtcMs(date: IsoDate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new TypeError(`isoDateToUtcMs: malformed date "${date}"`);
  }
  return Date.UTC(year, month - 1, day);
}

export function utcMsToIsoDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return utcMsToIsoDate(isoDateToUtcMs(date) + days * MS_PER_DAY);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((isoDateToUtcMs(b) - isoDateToUtcMs(a)) / MS_PER_DAY);
}

/** 0 = Monday … 6 = Sunday. */
export function dayOfWeekMonday0(date: IsoDate): number {
  return (new Date(isoDateToUtcMs(date)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `date`. */
export function weekStart(date: IsoDate): IsoDate {
  return addDays(date, -dayOfWeekMonday0(date));
}

export function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function quarterStart(date: IsoDate): IsoDate {
  const month = Number(date.slice(5, 7));
  const quarterMonth = month - ((month - 1) % 3);
  return `${date.slice(0, 4)}-${String(quarterMonth).padStart(2, '0')}-01`;
}

export function yearStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 4)}-01-01`;
}

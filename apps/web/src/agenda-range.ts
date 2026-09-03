/**
 * How the Agenda names the stretch of days it is showing.
 *
 * The header read `2026-08-16 – 2026-08-20`: precise, and nothing you take in at
 * a glance. It now says it the way a person would — `August 16–20` — with the
 * ISO pair kept as an option for anyone who wants the year spelled out.
 *
 * Every shape collapses when the range straddles nothing and opens up when it
 * does, rather than quietly naming only the first half: a span is a rolling
 * window from today, NOT a calendar week, so five days from a Sunday really do
 * cross a month, a week, or a year boundary, and `Week 33` has to become
 * `Weeks 33–34` when they do.
 *
 * The year appears only when the two ends disagree about it. Within one year it
 * is noise, and the ISO option is there for anyone who wants it always.
 *
 * The math is pure and lives here rather than in the screen, for the reason
 * `agenda-layout` and `agenda-snap` do: the screen hands it two dates and
 * renders the string back. The preference is per-device (localStorage), like
 * the day-span picker and the snap grid beside it — it applies the moment it is
 * picked, with nothing to sync and no `user_settings` column behind it.
 */
import { useSyncExternalStore } from 'react';

export const RANGE_KEY = 'prisms.agenda.range';

export type RangeFormat = 'month-days' | 'month' | 'week' | 'dates';

/** The offered shapes. The example beside each one is computed live, not written here. */
export const RANGE_FORMATS: readonly { value: RangeFormat; label: string }[] = [
  { value: 'month-days', label: 'Month and days' },
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week number' },
  { value: 'dates', label: 'Dates' },
];

export const DEFAULT_RANGE_FORMAT: RangeFormat = 'month-days';

export const isRangeFormat = (v: string): v is RangeFormat => RANGE_FORMATS.some((o) => o.value === v);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Parts {
  y: number;
  m: number;
  d: number;
}

/**
 * `YYYY-MM-DD` → its parts, by splitting rather than parsing: `new Date('2026-08-16')`
 * is UTC midnight, which is the PREVIOUS day everywhere west of Greenwich — the
 * classic way a date label ends up off by one.
 */
function parts(iso: string): Parts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/**
 * The ISO-8601 week `iso` falls in.
 *
 * The week's THURSDAY decides which year owns it, which is the whole trick: it
 * is what makes January 1st come out as week 52 or 53 of the year before when
 * it lands early in the week, instead of a wrong week 1.
 *
 * Arithmetic in UTC throughout, so the machine's own zone cannot shift a day
 * across a boundary and change the answer.
 */
export function isoWeek(iso: string): number {
  const p = parts(iso);
  if (!p) return 0;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const weekday = day.getUTCDay() || 7; // Mon 1 … Sun 7, rather than JS's Sun 0
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // hop to this week's Thursday
  const jan1 = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.floor((day.getTime() - jan1) / 86_400_000 / 7) + 1;
}

/** "August 16" / "August 16, 2026" — the year only when asked for. */
const monthDay = (p: Parts, withYear: boolean): string =>
  `${MONTHS[p.m - 1]} ${p.d}${withYear ? `, ${p.y}` : ''}`;

/**
 * The Agenda header's label for the days between `from` and `to` (both
 * `YYYY-MM-DD`, inclusive). Returns the ISO pair for anything it cannot parse,
 * so a bad date shows as itself rather than as a confident wrong month.
 */
export function formatAgendaRange(from: string, to: string, format: RangeFormat): string {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return from === to ? from : `${from} – ${to}`;
  const sameYear = a.y === b.y;
  const sameMonth = sameYear && a.m === b.m;
  const sameDay = sameMonth && a.d === b.d;

  switch (format) {
    case 'dates':
      return sameDay ? from : `${from} – ${to}`;

    case 'week': {
      const first = isoWeek(from);
      const last = isoWeek(to);
      return first === last ? `Week ${first}` : `Weeks ${first}–${last}`;
    }

    case 'month': {
      if (sameMonth) return MONTHS[a.m - 1]!;
      const head = sameYear ? MONTHS[a.m - 1] : `${MONTHS[a.m - 1]} ${a.y}`;
      const tail = sameYear ? MONTHS[b.m - 1] : `${MONTHS[b.m - 1]} ${b.y}`;
      return `${head} – ${tail}`;
    }

    case 'month-days':
    default: {
      // Inside one month the month is said once and the days share it: the
      // shape the label exists for. Anything wider spells both ends out.
      if (sameDay) return monthDay(a, !sameYear);
      if (sameMonth) return `${MONTHS[a.m - 1]} ${a.d}–${b.d}`;
      return `${monthDay(a, !sameYear)} – ${monthDay(b, !sameYear)}`;
    }
  }
}

// --- the stored preference ------------------------------------------------
// A module-level store rather than screen state, for the reason `agenda-snap`
// keeps one: Settings writes it and the Agenda reads it, and on a wide window
// both are mounted at once.

const listeners = new Set<() => void>();

/** Read straight through — a primitive snapshot is stable enough for React. */
function readFormat(): RangeFormat {
  try {
    const stored = localStorage.getItem(RANGE_KEY) ?? '';
    return isRangeFormat(stored) ? stored : DEFAULT_RANGE_FORMAT;
  } catch {
    return DEFAULT_RANGE_FORMAT; // no storage (private mode, or a bare Node global)
  }
}

function onStorage(e: StorageEvent): void {
  // key === null is a whole-storage clear, which counts as a change.
  if (e.key !== null && e.key !== RANGE_KEY) return;
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function setRangeFormatPref(format: string): void {
  if (!isRangeFormat(format)) return;
  try {
    localStorage.setItem(RANGE_KEY, format);
  } catch {
    /* preference is best-effort — the session still honours it below */
  }
  for (const l of [...listeners]) l();
}

/** The live range format. Re-renders its caller when Settings changes it. */
export function useRangeFormatPref(): RangeFormat {
  return useSyncExternalStore(subscribe, readFormat, () => DEFAULT_RANGE_FORMAT);
}

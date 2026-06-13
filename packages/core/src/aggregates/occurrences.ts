/**
 * Habit occurrence engine: evaluates RRULE strings (§4: rrule.js, stored in
 * habits.rrule) into civil occurrence dates.
 *
 * Occurrences are floating 'YYYY-MM-DD' dates anchored at an explicit
 * dtstart date (the habit's creation date) — rrule's implicit "dtstart =
 * now" default is never reachable, keeping core pure and runs deterministic.
 * All rrule math happens at UTC midnight; user-zone semantics enter only
 * through day bucketing (§7.2), which already produced the dates that
 * completions carry.
 */
import { RRule } from 'rrule';

import type { IsoDate } from '../domain/primitives';
import { isoDateToUtcMs, utcMsToIsoDate } from '../time/dates';

const ruleCache = new Map<string, RRule>();

function ruleFor(rruleString: string, dtstart: IsoDate): RRule {
  const key = `${dtstart}|${rruleString}`;
  const cached = ruleCache.get(key);
  if (cached) return cached;
  let options: ReturnType<typeof RRule.parseString>;
  try {
    options = RRule.parseString(rruleString);
  } catch (error) {
    throw new TypeError(`occurrenceDates: invalid RRULE "${rruleString}"`, {
      cause: error,
    });
  }
  const rule = new RRule({
    ...options,
    dtstart: new Date(isoDateToUtcMs(dtstart)),
  });
  ruleCache.set(key, rule);
  return rule;
}

/**
 * Occurrence dates within [from, to] (inclusive). Dates before dtstart never
 * occur. Deterministic: identical inputs ⇒ identical output.
 */
export function occurrenceDates(
  rruleString: string,
  dtstart: IsoDate,
  from: IsoDate,
  to: IsoDate,
): IsoDate[] {
  if (to < from) return [];
  const rule = ruleFor(rruleString, dtstart);
  return rule
    .between(new Date(isoDateToUtcMs(from)), new Date(isoDateToUtcMs(to)), true)
    .map((d) => utcMsToIsoDate(d.getTime()));
}

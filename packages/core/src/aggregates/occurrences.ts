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
// rrule ships an ESM build (`module`) AND a CJS `main` but no `exports` map,
// so it resolves DIFFERENTLY per environment: raw Node/tsx loads the CJS main
// (RRule only reachable via the default = module.exports), while a bundler
// (Vite) loads the ESM build (RRule is a named export, no default). A
// namespace import + runtime default/named fallback works in both.
import * as rruleModule from 'rrule';

import type { IsoDate } from '../domain/primitives';
import { isoDateToUtcMs, utcMsToIsoDate } from '../time/dates';

type RRuleExports = { RRule: typeof import('rrule').RRule };
const { RRule } = (rruleModule as { default?: RRuleExports }).default ?? (rruleModule as unknown as RRuleExports);
type RRuleInstance = InstanceType<typeof RRule>;

const ruleCache = new Map<string, RRuleInstance>();

/**
 * SEC-4/F7: habits recur on human cadences — daily through yearly. The
 * sub-daily frequencies exist in RFC 5545 but have no meaning for a habit, and
 * they are the whole DoS: `FREQ=SECONDLY` over a multi-year window materialises
 * tens of millions of `Date` objects inside `rule.between()`.
 *
 * That matters beyond the author's own session, because
 * `runAggregatesRecomputeAll` walks EVERY user sequentially in one nightly job —
 * so one such habit stalls recompute for everyone on the node.
 */
const ALLOWED_FREQUENCIES = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY'] as const;

/**
 * SEC-4/F7: ceiling on occurrences materialised from a single rule. ~10 years of
 * daily occurrences; far past any real habit window, far below a memory event.
 */
export const MAX_OCCURRENCES = 4_000;

/**
 * SEC-4/F7: can this RRULE be safely expanded for a habit? Used at the COMMAND
 * boundary (habit.create/update) so an unsupported rule is rejected on the way
 * in rather than throwing later inside a shared nightly job.
 */
export function isSupportedHabitRrule(rruleString: string): boolean {
  let options: ReturnType<typeof RRule.parseString>;
  try {
    options = RRule.parseString(rruleString);
  } catch {
    return false;
  }
  const allowed = new Set(ALLOWED_FREQUENCIES.map((name) => RRule[name] as unknown as number));
  return options.freq !== undefined && allowed.has(options.freq as unknown as number);
}

function ruleFor(rruleString: string, dtstart: IsoDate): RRuleInstance {
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
  // Reject sub-daily frequencies BEFORE constructing the rule. `options.freq` is
  // rrule's numeric enum, so compare against the allowed names' values.
  const allowedFreqValues = new Set(ALLOWED_FREQUENCIES.map((name) => RRule[name] as unknown as number));
  if (options.freq === undefined || !allowedFreqValues.has(options.freq as unknown as number)) {
    throw new TypeError(
      `occurrenceDates: RRULE frequency is not supported for habits (allowed: ${ALLOWED_FREQUENCIES.join(', ')}) — "${rruleString}"`,
    );
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
  // SEC-4/F7: the iterator form lets us stop at MAX_OCCURRENCES; the plain
  // `between()` would materialise the whole set before we could bound it.
  const out: IsoDate[] = [];
  rule.between(new Date(isoDateToUtcMs(from)), new Date(isoDateToUtcMs(to)), true, (date) => {
    out.push(utcMsToIsoDate(date.getTime()));
    return out.length < MAX_OCCURRENCES;
  });
  return out;
}

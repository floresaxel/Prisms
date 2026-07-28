/**
 * SEC-4/F7 — RRULE expansion must be bounded.
 *
 * `habits.rrule` was an unvalidated string expanded with `rule.between(from, to)`.
 * A `FREQ=SECONDLY` habit materialises tens of millions of Date objects, and
 * because `runAggregatesRecomputeAll` walks EVERY user sequentially in one
 * nightly job, one such habit stalls recompute for everyone on the node.
 */
import { describe, expect, it } from 'vitest';

import { MAX_OCCURRENCES, occurrenceDates } from '../../src/aggregates/occurrences';

describe('SEC-4/F7 — sub-daily frequencies are refused', () => {
  it.each(['FREQ=SECONDLY', 'FREQ=MINUTELY', 'FREQ=HOURLY'])('rejects %s', (rrule) => {
    expect(() => occurrenceDates(rrule, '2020-01-01', '2020-01-01', '2030-01-01')).toThrow(/not supported for habits/);
  });

  it('REGRESSION: the DoS payload fails fast instead of expanding', () => {
    const startedAt = Date.now();
    expect(() => occurrenceDates('FREQ=SECONDLY', '2020-01-01', '2020-01-01', '2030-01-01')).toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('still rejects a malformed rule', () => {
    expect(() => occurrenceDates('NOT-AN-RRULE', '2026-01-01', '2026-01-01', '2026-02-01')).toThrow(/invalid RRULE/);
  });
});

describe('SEC-4/F7 — human cadences still work', () => {
  it('expands a daily habit over a month', () => {
    const dates = occurrenceDates('FREQ=DAILY', '2026-06-01', '2026-06-01', '2026-06-30');
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe('2026-06-01');
    expect(dates.at(-1)).toBe('2026-06-30');
  });

  it.each(['FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY'])('accepts %s', (rrule) => {
    expect(() => occurrenceDates(rrule, '2026-01-01', '2026-01-01', '2026-12-31')).not.toThrow();
  });

  it('honours BYDAY on a weekly rule', () => {
    const dates = occurrenceDates('FREQ=WEEKLY;BYDAY=MO', '2026-06-01', '2026-06-01', '2026-06-30');
    expect(dates).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']);
  });
});

describe('SEC-4/F7 — the occurrence count is capped', () => {
  it('stops at MAX_OCCURRENCES for an absurd window', () => {
    // Daily over ~270 years would be ~98k dates; the cap truncates it.
    const dates = occurrenceDates('FREQ=DAILY', '2000-01-01', '2000-01-01', '2270-01-01');
    expect(dates).toHaveLength(MAX_OCCURRENCES);
  });

  it('leaves a realistic window untouched by the cap', () => {
    const dates = occurrenceDates('FREQ=DAILY', '2026-01-01', '2026-01-01', '2026-12-31');
    expect(dates).toHaveLength(365);
    expect(dates.length).toBeLessThan(MAX_OCCURRENCES);
  });
});

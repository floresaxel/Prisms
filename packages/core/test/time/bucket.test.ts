/**
 * S2 DoD: day-reset golden tests, including DST transitions.
 *
 * America/New_York 2026: spring forward Sun Mar 8 (02:00 EST → 03:00 EDT),
 * fall back Sun Nov 1 (02:00 EDT → 01:00 EST).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bucketDate } from '../../src/time/bucket';
import { asEpochMillis } from '../../src/time/instant';

const NY = 'America/New_York';

describe('bucketDate goldens (reset hour 4, America/New_York)', () => {
  const cases: [ts: string, expected: string, why: string][] = [
    // plain days
    ['2026-06-11T03:59:59-04:00', '2026-06-10', 'one second before reset → previous day'],
    ['2026-06-11T04:00:00-04:00', '2026-06-11', 'exactly at reset → new day'],
    ['2026-06-11T23:30:00-04:00', '2026-06-11', 'late evening → same day'],
    // year boundary
    ['2026-01-01T02:00:00-05:00', '2025-12-31', 'new year 2am still belongs to Dec 31'],
    // spring forward (Mar 8 2026): 02:00 EST jumps to 03:00 EDT
    ['2026-03-08T01:59:00-05:00', '2026-03-07', 'before the gap, before reset'],
    ['2026-03-08T03:30:00-04:00', '2026-03-07', '03:30 EDT (right after the gap) is still before the 4am reset'],
    ['2026-03-08T04:30:00-04:00', '2026-03-08', '04:30 EDT crosses the reset on the short day'],
    // fall back (Nov 1 2026): 02:00 EDT returns to 01:00 EST — 01:30 happens twice
    ['2026-11-01T01:30:00-04:00', '2026-10-31', 'first 01:30 (EDT) → previous day'],
    ['2026-11-01T01:30:00-05:00', '2026-10-31', 'second 01:30 (EST) → same bucket, deterministic per instant'],
    ['2026-11-01T04:00:00-05:00', '2026-11-01', 'reset hour on the long day'],
  ];

  it.each(cases)('%s → %s (%s)', (ts, expected) => {
    expect(bucketDate(ts, 4, NY)).toBe(expected);
  });
});

describe('bucketDate goldens (other zones and reset hours)', () => {
  it('reset 0 makes buckets plain local dates', () => {
    expect(bucketDate('2026-06-11T23:59:59-04:00', 0, NY)).toBe('2026-06-11');
    expect(bucketDate('2026-06-12T00:00:00-04:00', 0, NY)).toBe('2026-06-12');
  });

  it('handles non-DST zones (Asia/Tokyo)', () => {
    expect(bucketDate('2026-06-12T03:59:00+09:00', 4, 'Asia/Tokyo')).toBe('2026-06-11');
    expect(bucketDate('2026-06-12T04:00:00+09:00', 4, 'Asia/Tokyo')).toBe('2026-06-12');
  });

  it('handles UTC', () => {
    expect(bucketDate('2026-06-12T03:59:00Z', 4, 'UTC')).toBe('2026-06-11');
    expect(bucketDate('2026-06-12T04:00:00Z', 4, 'UTC')).toBe('2026-06-12');
  });

  it('the same instant buckets differently across zones', () => {
    const ts = '2026-06-12T05:00:00Z'; // 01:00 in New York, 14:00 in Tokyo
    expect(bucketDate(ts, 4, NY)).toBe('2026-06-11');
    expect(bucketDate(ts, 4, 'Asia/Tokyo')).toBe('2026-06-12');
  });

  it('accepts epoch millis input', () => {
    const ms = asEpochMillis(Date.parse('2026-06-11T08:00:00Z')); // 04:00 EDT
    expect(bucketDate(ms, 4, NY)).toBe('2026-06-11');
  });
});

describe('bucketDate contract', () => {
  it('rejects invalid reset hours', () => {
    expect(() => bucketDate('2026-06-11T12:00:00Z', -1, 'UTC')).toThrow(TypeError);
    expect(() => bucketDate('2026-06-11T12:00:00Z', 24, 'UTC')).toThrow(TypeError);
    expect(() => bucketDate('2026-06-11T12:00:00Z', 4.5, 'UTC')).toThrow(TypeError);
  });

  it('rejects unknown timezones', () => {
    expect(() => bucketDate('2026-06-11T12:00:00Z', 4, 'Mars/Olympus_Mons')).toThrow(RangeError);
  });

  it('always returns YYYY-MM-DD and is non-decreasing in time', () => {
    const zones = ['UTC', NY, 'Asia/Tokyo', 'Europe/Paris', 'Australia/Lord_Howe'];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_102_444_800_000 }), // 1970..2100
        fc.integer({ min: 0, max: 365 * 86_400_000 }),
        fc.integer({ min: 0, max: 23 }),
        fc.constantFrom(...zones),
        (start, delta, resetHour, zone) => {
          const earlier = bucketDate(asEpochMillis(start), resetHour, zone);
          const later = bucketDate(asEpochMillis(start + delta), resetHour, zone);
          expect(earlier).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(later >= earlier).toBe(true); // ISO dates compare chronologically
        },
      ),
    );
  });
});

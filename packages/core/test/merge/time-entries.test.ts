/**
 * M1 — `mergeTimeEntries` (1.3 §7.10b): union-not-sum, idempotent,
 * order-independent. The single source of truth for effective hours.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeTimeEntries, type MergeableEntry } from '../../src/merge/time-entries';

const iso = (ms: number): string => new Date(ms).toISOString();
let seq = 0;
const entry = (startMs: number, endMs: number | null, focus?: number): MergeableEntry => ({
  id: `e${(seq += 1)}`,
  started_at: iso(startMs),
  ended_at: endMs === null ? null : iso(endMs),
  focus_factor: focus,
});

const H = 3_600_000;

describe('union-not-sum (§7.10b)', () => {
  it('overlapping intervals count once', () => {
    // 10:00-11:00 and 10:30-11:30 → union 10:00-11:30 = 90 min, not 120
    const r = mergeTimeEntries([entry(10 * H, 11 * H), entry(10.5 * H, 11.5 * H)]);
    expect(r.rawMinutes).toBe(90);
    expect(r.segments).toEqual([{ start: iso(10 * H), end: iso(11.5 * H) }]);
  });

  it('disjoint intervals sum (no overlap to dedupe)', () => {
    const r = mergeTimeEntries([entry(9 * H, 10 * H), entry(11 * H, 12 * H)]);
    expect(r.rawMinutes).toBe(120);
    expect(r.segments).toHaveLength(2);
  });

  it('a duplicate (identical) interval counts once', () => {
    const r = mergeTimeEntries([entry(9 * H, 10 * H), entry(9 * H, 10 * H)]);
    expect(r.rawMinutes).toBe(60);
  });

  it('effective minutes integrate focus, taking the max focus over an overlap', () => {
    // [10:00-11:00 @0.5] and [10:30-11:30 @1.0]: union 90 min raw; effective =
    // 30 min@0.5 (10:00-10:30) + 30 min@1.0 (10:30-11:00) + 30 min@1.0 (11:00-11:30)
    const r = mergeTimeEntries([entry(10 * H, 11 * H, 0.5), entry(10.5 * H, 11.5 * H, 1.0)]);
    expect(r.rawMinutes).toBe(90);
    expect(r.effectiveMinutes).toBe(15 + 30 + 30); // 75
  });

  it('reports open entries earliest-start first; closed-only has no open', () => {
    const r = mergeTimeEntries([entry(10 * H, null), entry(9 * H, null)]);
    expect(r.open?.earliestStart).toBe(iso(9 * H));
    expect(r.open?.entryIds).toHaveLength(2);
    expect(mergeTimeEntries([entry(9 * H, 10 * H)]).open).toBeNull();
  });
});

describe('idempotency', () => {
  it('re-merging the merged segments yields the same union', () => {
    const once = mergeTimeEntries([entry(10 * H, 11 * H), entry(10.5 * H, 11.5 * H), entry(13 * H, 14 * H)]);
    const asEntries: MergeableEntry[] = once.segments.map((s, i) => ({ id: `s${i}`, started_at: s.start, ended_at: s.end }));
    const twice = mergeTimeEntries(asEntries);
    expect(twice.segments).toEqual(once.segments);
    expect(twice.rawMinutes).toBe(once.rawMinutes);
  });
});

describe('order-independence (property)', () => {
  it('the result is invariant under input permutation', () => {
    const intervalArb = fc
      .record({ start: fc.integer({ min: 0, max: 40 }), len: fc.integer({ min: 1, max: 20 }), focus: fc.constantFrom(0.5, 0.75, 1.0) })
      .map(({ start, len, focus }) => entry(start * H, (start + len) * H, focus));
    fc.assert(
      fc.property(fc.array(intervalArb, { minLength: 1, maxLength: 8 }), (entries) => {
        const base = mergeTimeEntries(entries);
        const shuffled = mergeTimeEntries([...entries].reverse());
        expect(shuffled.segments).toEqual(base.segments);
        expect(shuffled.rawMinutes).toBeCloseTo(base.rawMinutes, 9);
        expect(shuffled.effectiveMinutes).toBeCloseTo(base.effectiveMinutes, 9);
      }),
    );
  });

  it('union never exceeds the naive sum and never double-counts the span', () => {
    const intervalArb = fc
      .record({ start: fc.integer({ min: 0, max: 40 }), len: fc.integer({ min: 1, max: 20 }) })
      .map(({ start, len }) => entry(start * H, (start + len) * H));
    fc.assert(
      fc.property(fc.array(intervalArb, { minLength: 1, maxLength: 8 }), (entries) => {
        const r = mergeTimeEntries(entries);
        const naiveSum = entries.reduce((m, e) => m + (new Date(e.ended_at!).getTime() - new Date(e.started_at).getTime()) / 60_000, 0);
        expect(r.rawMinutes).toBeLessThanOrEqual(naiveSum + 1e-9);
      }),
    );
  });
});

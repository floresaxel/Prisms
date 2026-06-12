import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createManualClock } from '../../src/time/clock';
import {
  addMinutes,
  minutesBetween,
  minutesToMs,
  msToMinutes,
} from '../../src/time/duration';
import {
  asEpochMillis,
  epochMillisToIso,
  isoToEpochMillis,
  toEpochMillis,
} from '../../src/time/instant';
import { createSeededRng } from '../../src/time/rng';

describe('instants', () => {
  it('iso ⇄ epoch ms round-trips', () => {
    const iso = '2026-06-11T12:34:56.789Z';
    expect(epochMillisToIso(isoToEpochMillis(iso))).toBe(iso);
  });

  it('parses offsets into the same instant', () => {
    expect(isoToEpochMillis('2026-06-11T08:00:00-04:00')).toBe(
      isoToEpochMillis('2026-06-11T12:00:00Z'),
    );
  });

  it('toEpochMillis accepts both representations', () => {
    const ms = asEpochMillis(1_718_000_000_000);
    expect(toEpochMillis(ms)).toBe(ms);
    expect(toEpochMillis(epochMillisToIso(ms))).toBe(ms);
  });

  it('rejects garbage', () => {
    expect(() => isoToEpochMillis('not a date')).toThrow(TypeError);
    expect(() => asEpochMillis(1.5)).toThrow(TypeError);
    expect(() => asEpochMillis(Number.NaN)).toThrow(TypeError);
  });
});

describe('duration math', () => {
  it('addMinutes works over both input kinds', () => {
    expect(addMinutes('2026-06-11T12:00:00Z', 90)).toBe(
      isoToEpochMillis('2026-06-11T13:30:00Z'),
    );
    expect(addMinutes(asEpochMillis(0), -1)).toBe(-60_000);
  });

  it('minutesBetween is exact and signed', () => {
    expect(minutesBetween('2026-06-11T12:00:00Z', '2026-06-11T12:45:30Z')).toBe(45.5);
    expect(minutesBetween('2026-06-11T12:45:30Z', '2026-06-11T12:00:00Z')).toBe(-45.5);
  });

  it('minutesToMs and msToMinutes are inverses', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (minutes) => {
        expect(msToMinutes(minutesToMs(minutes))).toBe(minutes);
      }),
    );
  });
});

describe('manual clock', () => {
  it('advances and sets explicitly — time never moves on its own', () => {
    const clock = createManualClock(100);
    expect(clock.now()).toBe(100);
    expect(clock.now()).toBe(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.set(42);
    expect(clock.now()).toBe(42);
    clock.advance(-2);
    expect(clock.now()).toBe(40);
  });
});

describe('seeded rng', () => {
  it('same seed ⇒ identical byte stream', () => {
    const a = createSeededRng(1234);
    const b = createSeededRng(1234);
    expect(a.randomBytes(32)).toEqual(b.randomBytes(32));
    // and the stream continues deterministically
    expect(a.randomBytes(8)).toEqual(b.randomBytes(8));
  });

  it('different seeds ⇒ different streams (golden)', () => {
    expect(createSeededRng(1).randomBytes(16)).not.toEqual(
      createSeededRng(2).randomBytes(16),
    );
  });

  it('honors requested lengths, including odd ones', () => {
    for (const length of [0, 1, 3, 5, 16, 33]) {
      expect(createSeededRng(9).randomBytes(length)).toHaveLength(length);
    }
  });

  it('rejects invalid lengths and seeds', () => {
    expect(() => createSeededRng(0).randomBytes(-1)).toThrow(TypeError);
    expect(() => createSeededRng(0).randomBytes(1.5)).toThrow(TypeError);
    expect(() => createSeededRng(Number.NaN)).toThrow(TypeError);
  });
});

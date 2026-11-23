/**
 * Ids stay time-ordered when the computer's clock is set back: the overlay store
 * reads command order from the UUIDv7, so an id minted after a clock change must
 * still sort after every id minted before it.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __resetIdClockForTests, nextIdMs } from '../src/powersync/client-runtime';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('nextIdMs — monotonic id clock', () => {
  beforeEach(() => __resetIdClockForTests());

  it('follows the wall clock while it moves forward', () => {
    const s = memoryStorage();
    expect(nextIdMs(1_000, s)).toBe(1_000);
    expect(nextIdMs(5_000, s)).toBe(5_000);
  });

  it('never goes back when the clock is set back an hour', () => {
    const s = memoryStorage();
    const before = nextIdMs(10_000_000, s);
    const after = nextIdMs(10_000_000 - 3_600_000, s);
    const next = nextIdMs(10_000_000 - 3_599_000, s);
    expect(after).toBeGreaterThan(before);
    expect(next).toBeGreaterThan(after);
  });

  it('keeps the high-water across a reload', () => {
    const s = memoryStorage();
    nextIdMs(10_000_000, s);
    __resetIdClockForTests(); // a reload: memory is gone, storage is not
    expect(nextIdMs(1_000, s)).toBe(10_000_001);
  });
});

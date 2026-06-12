/**
 * Injected clock (ARCHITECTURE.md §16): core never reads the wall clock.
 *
 * Apps provide a system clock (e.g. `() => Date.now()` wrapped at the app
 * boundary); core ships only the interface plus a manual clock for tests,
 * replay, and simulations.
 */
import { asEpochMillis, type EpochMillis } from './instant';

export interface Clock {
  now(): EpochMillis;
}

export interface ManualClock extends Clock {
  /** Moves the clock forward (negative values allowed to simulate clock skew). */
  advance(byMs: number): void;
  set(toMs: number): void;
}

export function createManualClock(startMs = 0): ManualClock {
  let current = asEpochMillis(startMs);
  return {
    now: () => current,
    advance: (byMs: number) => {
      current = asEpochMillis(current + byMs);
    },
    set: (toMs: number) => {
      current = asEpochMillis(toMs);
    },
  };
}

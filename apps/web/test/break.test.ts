/**
 * Break timeline + journal line (break.ts): the phases that drive the prompt and
 * the auto-close, the countdown text (negative past the end), the time-taken cap
 * of end + 10 min, and that a break closes exactly once.
 */
import { describe, expect, it } from 'vitest';

import {
  BREAK_OVERTIME_MS,
  breakJournalLine,
  breakPhase,
  breakRemainingMs,
  breakTakenMs,
  formatCountdown,
  loadBreak,
  saveBreak,
  takeBreak,
  type ActiveBreak,
} from '../src/break';

const MIN = 60_000;
const START = Date.UTC(2026, 10, 22, 19, 5); // 2:05 PM in New York
const brk = (minutes = 15): ActiveBreak => ({ id: 'b1', startedAt: START, minutes, tasks: [{ taskId: 't1', title: 'Write report' }], prompted: false });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('breakPhase — when the prompt opens and the break closes', () => {
  it('is on until the last minute, ending in it, over past the end, expired 10 min past', () => {
    const b = brk(15);
    expect(breakPhase(b, START)).toBe('on');
    expect(breakPhase(b, START + 14 * MIN - 1)).toBe('on');
    expect(breakPhase(b, START + 14 * MIN)).toBe('ending'); // exactly 1 min left → prompt
    expect(breakPhase(b, START + 15 * MIN)).toBe('over');
    expect(breakPhase(b, START + 25 * MIN - 1)).toBe('over');
    expect(breakPhase(b, START + 25 * MIN)).toBe('expired');
  });

  it('counts down to zero, then negative', () => {
    const b = brk(5);
    expect(breakRemainingMs(b, START)).toBe(5 * MIN);
    expect(breakRemainingMs(b, START + 7 * MIN)).toBe(-2 * MIN);
    expect(breakRemainingMs(b, START - 800)).toBe(5 * MIN); // a lagging clock never reads 5:01
  });
});

describe('formatCountdown', () => {
  it('shows minutes:seconds, rounding a part-second left up', () => {
    expect(formatCountdown(15 * MIN)).toBe('15:00');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('goes negative once a whole second over', () => {
    expect(formatCountdown(-999)).toBe('0:00');
    expect(formatCountdown(-1000)).toBe('-0:01');
    expect(formatCountdown(-(9 * MIN + 59_000))).toBe('-9:59');
    expect(formatCountdown(-BREAK_OVERTIME_MS)).toBe('-10:00');
  });
});

describe('time taken + the journal line', () => {
  it('is the real length, capped at the end + 10 min', () => {
    const b = brk(15);
    expect(breakTakenMs(b, START + 8 * MIN)).toBe(8 * MIN); // came back early
    expect(breakTakenMs(b, START + 21 * MIN)).toBe(21 * MIN); // 6 min over
    expect(breakTakenMs(b, START + 3 * 60 * MIN)).toBe(25 * MIN); // app closed for hours: capped
  });

  it('logs length and times, and how far over when it ran over', () => {
    const b = brk(15);
    expect(breakJournalLine(b, START + 15 * MIN, 'America/New_York')).toBe('☕ Break — 15 min (2:05 PM – 2:20 PM)');
    expect(breakJournalLine(b, START + 4 * 60 * MIN, 'America/New_York')).toBe('☕ Break — 25 min (2:05 PM – 2:30 PM) · 10 min over the 15 planned');
    expect(breakJournalLine(b, START + 20_000, 'America/New_York')).toBe('☕ Break — under a minute (2:05 PM – 2:05 PM)');
  });
});

describe('the saved break', () => {
  it('round-trips and closes exactly once (a second tab or click finds it gone)', () => {
    const s = memoryStorage();
    const b = brk(10);
    saveBreak('u1', b, s);
    expect(loadBreak('u1', s)).toEqual(b);
    expect(loadBreak('u2', s)).toBeNull(); // per account
    expect(takeBreak('u1', 'other-id', s)).toBeNull(); // not the running break
    expect(takeBreak('u1', 'b1', s)).toEqual(b);
    expect(takeBreak('u1', 'b1', s)).toBeNull();
    expect(loadBreak('u1', s)).toBeNull();
  });
});

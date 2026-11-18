/** The long-session card's time math: duration ⇄ exact end, in the user's timezone. */
import { describe, expect, it } from 'vitest';

import { endError, endFromDuration, formatDuration, fromLocalInput, splitDuration, toLocalInput } from '../src/long-session-edit';

const H = 3_600_000;
const START = Date.parse('2026-11-16T14:05:00.000Z'); // 09:05 in New York (EST)
const TZ = 'America/New_York';

describe('long-session edit helpers', () => {
  it('round-trips a datetime-local value through the user timezone, not the browser one', () => {
    expect(toLocalInput(START, TZ)).toBe('2026-11-16T09:05');
    expect(fromLocalInput('2026-11-16T09:05', TZ)).toBe(START);
    expect(toLocalInput(START, 'Asia/Tokyo')).toBe('2026-11-16T23:05');
    expect(fromLocalInput('', TZ)).toBeNull();
    expect(fromLocalInput('garbage', TZ)).toBeNull();
  });

  it('turns "time actually spent" into an end instant', () => {
    expect(endFromDuration(START, '2', '30')).toBe(START + 2.5 * H);
    expect(endFromDuration(START, '', '45')).toBe(START + 45 * 60_000);
    expect(endFromDuration(START, '1.5', '')).toBe(START + 1.5 * H);
    expect(endFromDuration(START, '-1', '0')).toBeNull();
    expect(endFromDuration(START, 'x', '0')).toBeNull();
  });

  it('splits and formats durations to the minute', () => {
    expect(splitDuration(7 * H + 14 * 60_000 + 29_000)).toEqual({ hours: 7, minutes: 14 });
    expect(formatDuration(24 * H)).toBe('24h 00m');
    expect(formatDuration(-5)).toBe('0h 00m');
  });

  it('refuses an end before the start, in the future, or unparseable', () => {
    const now = START + 30 * H;
    expect(endError(START + H, START, now)).toBeNull();
    expect(endError(START, START, now)).toMatch(/after it started/);
    expect(endError(now + 10 * 60_000, START, now)).toMatch(/future/);
    expect(endError(null, START, now)).toMatch(/valid/);
  });
});

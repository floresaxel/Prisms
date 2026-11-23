import { describe, expect, it } from 'vitest';

import { loggedText } from '../src/format';

describe('loggedText', () => {
  it('says so when nothing is logged', () => {
    expect(loggedText(0, null)).toBe('nothing logged yet');
    expect(loggedText(0.3, 120)).toBe('nothing logged yet'); // under half a minute rounds away
  });

  it('formats the time like a task’s “logged” note', () => {
    expect(loggedText(45, null)).toBe('45m logged');
    expect(loggedText(95.4, null)).toBe('1h 35m logged');
  });

  it('adds the share of the duration budget, past 100% too', () => {
    expect(loggedText(60, 240)).toBe('1h 0m logged · 25% of duration');
    expect(loggedText(300, 240)).toBe('5h 0m logged · 125% of duration');
  });

  it('ignores an empty budget', () => {
    expect(loggedText(60, 0)).toBe('1h 0m logged');
  });
});

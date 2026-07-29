/** T1: the itinerary's duration copy, which mirrors the mockup's wording. */
import { describe, expect, it } from 'vitest';

import { formatDurationLong } from '../src/format';

describe('formatDurationLong', () => {
  it('renders sub-hour durations in minutes', () => {
    expect(formatDurationLong(45)).toBe('45 min');
    expect(formatDurationLong(0)).toBe('0 min');
  });

  it('singularises one hour and pluralises the rest', () => {
    expect(formatDurationLong(60)).toBe('1hr');
    expect(formatDurationLong(120)).toBe('2hrs');
  });

  it('combines hours and minutes the way the mock does', () => {
    expect(formatDurationLong(90)).toBe('1hr 30min');
    expect(formatDurationLong(157)).toBe('2hrs 37min');
  });

  it('rounds and floors at zero rather than emitting a negative duration', () => {
    expect(formatDurationLong(44.6)).toBe('45 min');
    expect(formatDurationLong(-10)).toBe('0 min');
  });
});

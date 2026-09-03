// @vitest-environment jsdom
/**
 * The Agenda header's date-range label.
 *
 * A span is a rolling window from today, not a calendar week, so every boundary
 * a label could straddle is reachable in normal use — and naming only the first
 * half is the failure this suite exists to catch. The week numbers below are
 * ISO-8601, where the week's Thursday decides which year owns it.
 *
 * The formatting is pure `(from, to, format) → string`; the stored preference at
 * the bottom is the contract between Settings (which writes it) and the Agenda
 * (which reads it), and that half needs a DOM for `localStorage`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RANGE_FORMAT,
  formatAgendaRange,
  isoWeek,
  isRangeFormat,
  RANGE_FORMATS,
  RANGE_KEY,
  setRangeFormatPref,
} from '../src/agenda-range';
import { installMemoryStorage } from './util/memory-storage';

const fmt = formatAgendaRange;

describe('month and days — the default', () => {
  it('says the month once when the range does not leave it', () => {
    expect(fmt('2026-08-16', '2026-08-20', 'month-days')).toBe('August 16–20');
  });

  it('spells both ends when the range crosses a month', () => {
    expect(fmt('2026-08-30', '2026-09-03', 'month-days')).toBe('August 30 – September 3');
  });

  it('brings the year back only when the two ends disagree about it', () => {
    expect(fmt('2026-12-30', '2027-01-03', 'month-days')).toBe('December 30, 2026 – January 3, 2027');
  });

  it('does not repeat a single day against itself', () => {
    // span 1 is an offered choice, so this is a real screen, not a curiosity.
    expect(fmt('2026-08-16', '2026-08-16', 'month-days')).toBe('August 16');
  });

  it('is what a fresh install gets', () => {
    expect(DEFAULT_RANGE_FORMAT).toBe('month-days');
  });
});

describe('month', () => {
  it('names the one month a range sits inside', () => {
    expect(fmt('2026-08-16', '2026-08-20', 'month')).toBe('August');
  });

  it('names both when it does not', () => {
    expect(fmt('2026-08-30', '2026-09-03', 'month')).toBe('August – September');
  });

  it('carries the years across a new year', () => {
    expect(fmt('2026-12-30', '2027-01-03', 'month')).toBe('December 2026 – January 2027');
  });
});

describe('week number', () => {
  it('names the single ISO week a range sits inside', () => {
    // Mon 2026-08-10 … Sun 2026-08-16 is one ISO week.
    expect(fmt('2026-08-10', '2026-08-16', 'week')).toBe('Week 33');
  });

  it('names both when the range straddles two — the ordinary case', () => {
    // The screenshot's own window: five days from Sunday 2026-08-16. The Sunday
    // closes week 33 and the Monday opens 34, so a single number would be a lie.
    expect(fmt('2026-08-16', '2026-08-20', 'week')).toBe('Weeks 33–34');
  });

  it('puts a Thursday January 1st in week 1 of its own year', () => {
    // 2026-01-01 falls on a Thursday, so its week belongs to 2026.
    expect(isoWeek('2026-01-01')).toBe(1);
  });

  it('leaves an early-week January 1st in the LAST week of the year before', () => {
    // 2027-01-01 is a Friday: its Thursday is 2026-12-31, so the week is 2026's.
    expect(isoWeek('2027-01-01')).toBe(53);
  });

  it('reads a date by its parts, not by parsing it into the machine zone', () => {
    // `new Date('2026-08-16')` is UTC midnight — the day BEFORE, anywhere west of
    // Greenwich. If that crept in, this Monday would report the previous week.
    expect(isoWeek('2026-08-17')).toBe(34);
  });
});

describe('dates — what the header used to say', () => {
  it('keeps the ISO pair', () => {
    expect(fmt('2026-08-16', '2026-08-20', 'dates')).toBe('2026-08-16 – 2026-08-20');
  });

  it('says a single day once', () => {
    expect(fmt('2026-08-16', '2026-08-16', 'dates')).toBe('2026-08-16');
  });
});

describe('the stored value', () => {
  it('accepts exactly the offered formats', () => {
    for (const o of RANGE_FORMATS) expect(isRangeFormat(o.value)).toBe(true);
    expect(isRangeFormat('week-number')).toBe(false);
    expect(isRangeFormat('')).toBe(false);
  });

  it('offers a month and a week-number shape', () => {
    const values = RANGE_FORMATS.map((o) => o.value);
    expect(values).toContain('month');
    expect(values).toContain('week');
  });

  it('shows an unparseable date as itself rather than a confident wrong month', () => {
    expect(fmt('not-a-date', '2026-08-20', 'month-days')).toBe('not-a-date – 2026-08-20');
  });
});

describe('the per-device preference — what Settings writes and the Agenda reads', () => {
  afterEach(() => localStorage.clear());

  it('stores a chosen format', () => {
    installMemoryStorage();
    setRangeFormatPref('week');
    expect(localStorage.getItem(RANGE_KEY)).toBe('week');
  });

  it('refuses a value it does not offer, rather than storing a label nothing can render', () => {
    const storage = installMemoryStorage();
    setRangeFormatPref('week');
    setRangeFormatPref('week-number'); // close, and not a format
    expect(storage.getItem(RANGE_KEY)).toBe('week');
  });
});

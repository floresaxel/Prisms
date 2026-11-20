// @vitest-environment jsdom
/**
 * The task due-date display: the format function for every shape (DD/MMM first and
 * by default), the per-device preference behind it, and the <DueDate> that draws a
 * calendar icon beside it — "Today" when the date is today.
 */
import { createElement } from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DueDate } from '../src/components/DueDate';
import {
  DEFAULT_DUE_DATE_FORMAT,
  DUE_DATE_FORMATS,
  DUE_FORMAT_KEY,
  formatDueDate,
  setDueDateFormatPref,
} from '../src/due-date-format';
import { installMemoryStorage } from './util/memory-storage';

beforeEach(() => void installMemoryStorage()); // a fresh store each test: Node's own localStorage is absent
afterEach(cleanup);

describe('formatDueDate', () => {
  it('writes DD/MMM by default', () => {
    expect(DEFAULT_DUE_DATE_FORMAT).toBe('dd-mmm');
    expect(formatDueDate('2026-11-20')).toBe('20/Nov');
    expect(formatDueDate('2026-01-05')).toBe('05/Jan');
  });

  it.each([
    ['dd-mmm', '20/Nov'],
    ['mmm-dd', 'Nov 20'],
    ['dd-mmm-yyyy', '20/Nov/2026'],
    ['dd-mm', '20/11'],
    ['mm-dd', '11/20'],
    ['iso', '2026-11-20'],
  ] as const)('%s → %s', (format, expected) => {
    expect(formatDueDate('2026-11-20', format)).toBe(expected);
  });

  it('offers every format it can write', () => {
    for (const o of DUE_DATE_FORMATS) expect(formatDueDate('2026-11-20', o.value)).not.toBe('');
    expect(DUE_DATE_FORMATS[0]!.value).toBe('dd-mmm');
  });

  it('hands back anything that is not an ISO date as it came', () => {
    expect(formatDueDate('soon')).toBe('soon');
    expect(formatDueDate('2026-13-01')).toBe('2026-13-01');
  });
});

describe('<DueDate>', () => {
  it('shows a calendar icon and the date in DD/MMM', () => {
    const { container } = render(createElement(DueDate, { date: '2026-12-01' }));
    const el = screen.getByTestId('due-date');
    expect(el.textContent).toBe('01/Dec');
    expect(container.querySelector('svg use')?.getAttribute('href')).toBe('#i-cal');
  });

  it('follows the format picked in Settings, live', () => {
    render(createElement(DueDate, { date: '2026-12-01' }));
    expect(screen.getByTestId('due-date').textContent).toBe('01/Dec');
    act(() => setDueDateFormatPref('mm-dd'));
    expect(screen.getByTestId('due-date').textContent).toBe('12/01');
    expect(localStorage.getItem(DUE_FORMAT_KEY)).toBe('mm-dd');
    act(() => setDueDateFormatPref('nonsense')); // ignored
    expect(screen.getByTestId('due-date').textContent).toBe('12/01');
  });

  it('reads "Today" in the blue chip when the date is today', () => {
    render(createElement(DueDate, { chip: true, date: '2026-12-01', todayDate: '2026-12-01' }));
    const el = screen.getByTestId('due-date');
    expect(el.textContent).toBe('Today');
    expect(el.className).toContain('px-due--today');
  });

  it('keeps the date for a day that is not today', () => {
    render(createElement(DueDate, { chip: true, date: '2026-12-02', todayDate: '2026-12-01' }));
    const el = screen.getByTestId('due-date');
    expect(el.textContent).toBe('02/Dec');
    expect(el.className).not.toContain('px-due--today');
  });
});

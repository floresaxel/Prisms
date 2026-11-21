import { describe, expect, it } from 'vitest';

import { formatNoteDate, noteHeadingOf, NOTE_DATE_FORMATS } from '../src/note-date-format';

describe('formatNoteDate', () => {
  it('defaults to weekday, day, month and year', () => {
    expect(formatNoteDate('2026-11-20')).toBe('Fri 20 Nov 2026');
    expect(formatNoteDate('2026-08-05')).toBe('Wed 5 Aug 2026');
  });

  it('writes every offered shape', () => {
    const out = Object.fromEntries(NOTE_DATE_FORMATS.map((o) => [o.value, formatNoteDate('2026-08-05', o.value)]));
    expect(out).toEqual({
      long: 'Wed 5 Aug 2026',
      'dd-mmm-yyyy': '05/Aug/2026',
      'mmm-dd-yyyy': 'Aug 05, 2026',
      'dd-mm-yyyy': '05/08/2026',
      'mm-dd-yyyy': '08/05/2026',
      iso: '2026-08-05',
    });
  });

  it('returns anything that is not an ISO date as it came', () => {
    expect(formatNoteDate('not a date')).toBe('not a date');
    expect(formatNoteDate('2026-13-01')).toBe('2026-13-01');
  });

  it('builds the untitled heading', () => {
    expect(noteHeadingOf('2026-08-05', 'iso')).toBe('Note · 2026-08-05');
  });
});

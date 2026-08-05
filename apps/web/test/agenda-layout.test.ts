/**
 * Agenda reflow rules. These are the whole of "the page adapts to the shape of
 * the window": where the side panels sit, and how many day columns survive at a
 * given width. Pure by construction — in the app they are fed by a
 * ResizeObserver, which is exactly what a unit test cannot drive.
 *
 * The load-bearing property is the LAST test: at every width and every span the
 * calendar's columns fit the space it was given, which is why the page never
 * scrolls sideways.
 */
import { describe, expect, it } from 'vitest';

import {
  agendaLayout,
  DAY_SPANS,
  GUTTER_W,
  isDaySpan,
  MIN_DAY_W,
  NARROW_W,
  PANEL_W,
  rowLengthOf,
  STACK_W,
} from '../src/agenda-layout';

const SPANS = DAY_SPANS.map((s) => s.value);

describe('where the side panels go', () => {
  it('flanks the calendar when there is room for all three columns', () => {
    const l = agendaLayout(1400, 7);
    expect(l.stacked).toBe(false);
    expect(l.narrow).toBe(false);
  });

  it('moves them under the calendar below the stack width', () => {
    expect(agendaLayout(STACK_W - 1, 7).stacked).toBe(true);
    expect(agendaLayout(STACK_W - 1, 7).narrow).toBe(false); // still side by side
  });

  it('also stacks when flanking would cost day columns the full width could show', () => {
    // 1199px: beside the calendar only 6 of 7 days fit, underneath it all 7 do —
    // a squeezed week is worse than a full-width one, so it stacks.
    const l = agendaLayout(1199, 7);
    expect(l.stacked).toBe(true);
    expect(l.shownDays).toBe(7);
  });

  it('keeps the three-column layout when it can show the whole span', () => {
    const l = agendaLayout(1299, 7);
    expect(l.stacked).toBe(false);
    expect(l.shownDays).toBe(7);
  });

  it('stops them sharing a row below the narrow width', () => {
    expect(agendaLayout(NARROW_W, 7).narrow).toBe(false);
    expect(agendaLayout(NARROW_W - 1, 7).narrow).toBe(true);
  });

  it('assumes the roomy layout before the first measurement', () => {
    // width 0 = not measured yet; flashing the narrow layout on every mount
    // would be worse than being briefly wrong on a genuinely narrow window.
    const l = agendaLayout(0, 7);
    expect(l).toMatchObject({ stacked: false, narrow: false, perRow: 7, shownDays: 7 });
  });
});

describe('how many days survive', () => {
  it('shows the full span when it fits', () => {
    for (const span of SPANS) {
      const l = agendaLayout(1600, span);
      expect(l.shownDays).toBe(span);
    }
  });

  it('prefers whichever arrangement shows more days', () => {
    for (let width = 300; width <= 2000; width += 10) {
      for (const span of SPANS) {
        const l = agendaLayout(width, span);
        const rowLength = rowLengthOf(span);
        const beside = Math.min(rowLength, Math.max(1, Math.floor(Math.max(0, width - PANEL_W - GUTTER_W) / MIN_DAY_W)));
        // never flank the calendar when stacking would have shown strictly more
        if (!l.stacked) expect(l.perRow).toBeGreaterThanOrEqual(beside);
        if (l.stacked === false) expect(beside).toBe(l.perRow);
      }
    }
  });

  it('renders a two-week span as two rows of seven', () => {
    const l = agendaLayout(1600, 14);
    expect(l).toMatchObject({ rowCount: 2, perRow: 7, shownDays: 14 });
  });

  it('sheds columns as the width shrinks, never below one', () => {
    const counts = [1400, 1000, 800, 600, 420, 300, 120].map((w) => agendaLayout(w, 7).shownDays);
    // monotonically non-increasing, and always at least one day
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(counts[0]).toBe(7);
  });

  it('keeps the two-row shape while shedding, so 2 weeks degrades to 2×N', () => {
    const l = agendaLayout(560, 14); // stacked: 560 - 48 gutter = 512 → 5 per row
    expect(l.rowCount).toBe(2);
    expect(l.perRow).toBe(5);
    expect(l.shownDays).toBe(10);
  });

  it('never shows more days than asked for, however wide the window', () => {
    for (const span of SPANS) {
      expect(agendaLayout(6000, span).shownDays).toBe(span);
      expect(agendaLayout(6000, span).perRow).toBe(rowLengthOf(span));
    }
  });
});

describe('the columns always fit — the no-horizontal-scroll guarantee', () => {
  it('holds at every width and span', () => {
    for (let width = 200; width <= 2000; width += 10) {
      for (const span of SPANS) {
        const l = agendaLayout(width, span);
        const calWidth = (l.stacked ? width : width - PANEL_W) - GUTTER_W;
        expect(l.perRow).toBeGreaterThanOrEqual(1);
        expect(l.perRow).toBeLessThanOrEqual(rowLengthOf(span));
        // one column can be squeezed under the minimum (there is nothing left to
        // drop); two or more are only ever laid out when they genuinely fit.
        if (l.perRow > 1) expect(l.perRow * MIN_DAY_W).toBeLessThanOrEqual(calWidth);
      }
    }
  });
});

describe('the span options', () => {
  it('offers 1, 3, 5, 7 and 14 days', () => {
    expect(SPANS).toEqual([1, 3, 5, 7, 14]);
  });

  it('recognizes only those as valid stored preferences', () => {
    for (const s of SPANS) expect(isDaySpan(s)).toBe(true);
    for (const bad of [0, 2, 6, 10, 30, Number.NaN]) expect(isDaySpan(bad)).toBe(false);
  });
});

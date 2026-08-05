/**
 * How the Agenda arranges itself at a given width — extracted as a pure function
 * so the reflow rules are testable without a browser (they are otherwise only
 * observable through a live ResizeObserver).
 *
 * Two independent decisions:
 *  - WHERE the side panels go. Above `STACK_W` they flank the calendar; below it
 *    they move underneath it, and below `NARROW_W` they stop sharing a row.
 *  - HOW MANY day columns fit. A column thinner than `MIN_DAY_W` is unreadable,
 *    so days are dropped rather than squeezed — that is what keeps the page from
 *    ever scrolling sideways.
 */

/** Narrower than this and the side panels move BELOW the calendar. */
export const STACK_W = 1040;
/** Narrower still and those two panels stop sitting side by side. */
export const NARROW_W = 720;
/** A day column thinner than this is unreadable, so days are dropped instead. */
export const MIN_DAY_W = 96;
/** The hour-label gutter, present once per row. */
export const GUTTER_W = 48;
/** to-schedule + note + the two grid gaps, only claimed in the 3-column layout. */
export const PANEL_W = 248 + 286 + 36;

/** How many days the user asked for. 14 renders as two rows of 7. */
export const DAY_SPANS = [
  { value: 1, label: '1 day', short: '1' },
  { value: 3, label: '3 days', short: '3' },
  { value: 5, label: '5 days', short: '5' },
  { value: 7, label: '1 week', short: '7' },
  { value: 14, label: '2 weeks', short: '2w' },
] as const;

export const DEFAULT_SPAN = 7;

export const isDaySpan = (n: number): boolean => DAY_SPANS.some((s) => s.value === n);

/** Days per row before any width pressure: a span over a week wraps at 7. */
export const rowLengthOf = (span: number): number => (span > 7 ? 7 : span);

export interface AgendaLayout {
  /** Side panels sit under the calendar rather than beside it. */
  stacked: boolean;
  /** …and no longer share a row with each other. */
  narrow: boolean;
  /** Day columns per row. */
  perRow: number;
  /** Rows of days (2 only for the two-week span). */
  rowCount: number;
  /** Days actually rendered — below `span` when the width cannot hold them. */
  shownDays: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * `width` is the Agenda section's own measured width; 0 means "not measured yet"
 * (first paint), which assumes the roomy layout so the common case does not
 * flash the narrow one.
 */
/** Day columns that fit in `outer`, once the hour gutter has taken its cut. */
const daysThatFit = (outer: number, rowLength: number) =>
  clamp(Math.floor(Math.max(0, outer - GUTTER_W) / MIN_DAY_W), 1, rowLength);

export function agendaLayout(width: number, span: number): AgendaLayout {
  const rowLength = rowLengthOf(span);
  const rowCount = Math.ceil(span / rowLength);
  if (width <= 0) {
    return { stacked: false, narrow: false, perRow: rowLength, rowCount, shownDays: rowLength * rowCount };
  }
  const beside = daysThatFit(width - PANEL_W, rowLength); // panels flanking the calendar
  const below = daysThatFit(width, rowLength); // panels underneath it
  // Stack when the window is plainly too narrow for three columns, and ALSO when
  // keeping the panels beside the calendar would cost days the full width could
  // have shown — a squeezed week is worse than a week under a full-width grid.
  const stacked = width < STACK_W || (beside < rowLength && below > beside);
  const narrow = width < NARROW_W;
  const perRow = stacked ? below : beside;
  return { stacked, narrow, perRow, rowCount, shownDays: perRow * rowCount };
}

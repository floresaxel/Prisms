/**
 * Whether a placement fits the plan, and where the plan has room.
 *
 * The calendar used to REFUSE a drop outside a free region. It now accepts it
 * and marks the clash instead, which turns one question into three: where a day
 * is genuinely free (the glow under a drag), what — if anything — is wrong with
 * a span once it has been placed (the caution on the block), and how two events
 * that now legally occupy the same minutes share the column (without which the
 * clashing block would hide behind its neighbour, taking its own caution icon
 * with it).
 *
 * All three are pure interval arithmetic, testable without a browser, which is
 * why they live here rather than in the screen — the same reason `agenda-layout`
 * does.
 */
import type { Instant, Interval } from '@prisms/core';

/** What can be wrong with a placement. An empty list means nothing is. */
export type FitProblem = 'overlap' | 'outside-hours';

/** Half-open: an event that ends exactly where the next begins is not a clash. */
export const overlapping = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Ascending, with overlapping — and merely touching — spans fused into one. */
export function mergeIntervals(spans: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/**
 * What is wrong with `span`: does it collide with something already there, and
 * does it sit inside the hours work may land in? An empty `hours` means no
 * hours are configured at all — there is nothing to be outside of, so that is
 * not reported as a problem.
 */
export function fitProblems(
  span: Interval,
  occupied: readonly Interval[],
  hours: readonly Interval[],
): FitProblem[] {
  const problems: FitProblem[] = [];
  if (occupied.some((o) => overlapping(span, o))) problems.push('overlap');
  const merged = mergeIntervals(hours);
  if (merged.length > 0 && !merged.some((h) => h.start <= span.start && span.end <= h.end)) {
    problems.push('outside-hours');
  }
  return problems;
}

/** The caution's tooltip; null when there is nothing to caution about. */
export function conflictMessage(problems: readonly FitProblem[]): string | null {
  const parts: string[] = [];
  if (problems.includes('overlap')) parts.push('overlaps another event');
  if (problems.includes('outside-hours')) parts.push('falls outside your scheduling hours');
  return parts.length > 0 ? `Heads up — this ${parts.join(', and ')}.` : null;
}

export interface DayRegion {
  startMin: number;
  endMin: number;
}

/**
 * `free` clipped to one day column, as minutes down the grid — merged, so a
 * continuous stretch of free time is ONE shape to outline rather than a stack
 * of hour-sized rectangles.
 */
export function regionsInDay(free: readonly Interval[], dayStart: Instant, gridMinutes: number): DayRegion[] {
  const dayEnd = dayStart + gridMinutes * 60_000;
  const clipped = free
    .map((r) => ({ start: Math.max(r.start, dayStart), end: Math.min(r.end, dayEnd) }))
    .filter((r) => r.end > r.start);
  return mergeIntervals(clipped).map((r) => ({
    startMin: (r.start - dayStart) / 60_000,
    endMin: (r.end - dayStart) / 60_000,
  }));
}

export interface Lane {
  /** 0-based position across the column. */
  lane: number;
  /** How many lanes the column is split into where this span sits. */
  lanes: number;
}

/**
 * Side-by-side lanes for spans that overlap — the standard calendar packing.
 * Each run of mutually-overlapping spans is a cluster; a cluster is split into
 * as many lanes as its deepest pile-up, and every span in it is drawn at that
 * width so the edges line up. A span that overlaps nothing gets the full width
 * (lane 0 of 1), which is the overwhelmingly common case.
 */
export function laneLayout<T extends Interval & { id: string }>(spans: readonly T[]): Map<string, Lane> {
  const out = new Map<string, Lane>();
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));

  let cluster: { id: string; end: number; lane: number }[] = [];
  /** The end of each open lane in the current cluster. */
  let laneEnds: number[] = [];

  const flush = () => {
    for (const s of cluster) out.set(s.id, { lane: s.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const s of sorted) {
    // a span starting at or after everything so far begins a fresh cluster
    if (cluster.length > 0 && laneEnds.every((e) => e <= s.start)) flush();
    // reuse the first lane that has finished; otherwise open a new one
    let lane = laneEnds.findIndex((e) => e <= s.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(s.end);
    } else {
      laneEnds[lane] = s.end;
    }
    cluster.push({ id: s.id, end: s.end, lane });
  }
  flush();
  return out;
}

/**
 * Window expansion (§10): named time-of-day windows → concrete dated
 * intervals across the horizon, in the user's timezone (DST-correct via
 * localInstant). Also the free-interval math the greedy placer builds on.
 */
import { addDays } from '../time/dates';
import { bucketDate, localInstant } from '../time/bucket';
import type { Instant } from '../time/instant';

import type { Interval, NamedWindow } from './types';

export interface ConcreteWindow extends Interval {
  windowId: string;
}

/**
 * Default daytime window (08:00–20:00 local) used until a window-config table
 * exists in §6.0. Shared by the client (drag hints, §10) and the server jobs
 * (optimize, past-due) so both agree on where work may land.
 */
export const DEFAULT_WINDOWS: readonly NamedWindow[] = [{ id: 'day', startMinute: 8 * 60, endMinute: 20 * 60 }];

/** Ascending by start, then windowId — stable for determinism. */
export function expandWindows(
  windows: readonly NamedWindow[],
  timezone: string,
  horizon: { from: Instant; to: Instant },
): ConcreteWindow[] {
  const out: ConcreteWindow[] = [];
  // local calendar dates (day-reset 0 = civil midnight) spanning the horizon,
  // padded a day each side so clipping handles edges.
  const first = addDays(bucketDate(horizon.from, 0, timezone), -1);
  const last = addDays(bucketDate(horizon.to, 0, timezone), 1);

  for (const w of windows) {
    const startH = Math.floor(w.startMinute / 60);
    const startM = w.startMinute % 60;
    const endH = Math.floor(w.endMinute / 60);
    const endM = w.endMinute % 60;
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const start = Math.max(localInstant(date, startH, timezone, startM), horizon.from);
      const end = Math.min(localInstant(date, endH, timezone, endM), horizon.to);
      if (end > start) out.push({ windowId: w.id, start, end });
    }
  }
  out.sort((a, b) => a.start - b.start || (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0));
  return out;
}

/** Insert an interval into a start-sorted array, keeping it sorted. */
export function insertSorted(sorted: Interval[], interval: Interval): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < interval.start) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, interval);
}

/**
 * Earliest instant ≥ `earliest` where a block of `durationMs` fits entirely
 * inside one allowed window and avoids every occupied interval. Both arrays
 * must be sorted by start. Returns null when nothing fits.
 */
export function earliestFit(
  windows: readonly Interval[],
  occupied: readonly Interval[],
  earliest: number,
  durationMs: number,
): number | null {
  for (const w of windows) {
    if (w.end <= earliest || w.end - w.start < durationMs) continue;
    let cursor = Math.max(w.start, earliest);
    if (w.end - cursor < durationMs) continue;
    for (const occ of occupied) {
      if (occ.end <= cursor) continue;
      if (occ.start >= w.end) break;
      if (occ.start - cursor >= durationMs) return cursor; // fits in the gap before occ
      if (occ.end > cursor) cursor = occ.end;
      if (w.end - cursor < durationMs) break;
    }
    if (w.end - cursor >= durationMs) return cursor;
  }
  return null;
}

/**
 * All free regions (≥ durationMs) within the allowed windows after removing
 * occupied intervals and clamping to `earliest`. Powers drag-to-agenda hints
 * (§10): the UI highlights these, dims the rest.
 */
export function freeRegions(
  windows: readonly Interval[],
  occupied: readonly Interval[],
  earliest: number,
  durationMs: number,
): Interval[] {
  const out: Interval[] = [];
  for (const w of windows) {
    let cursor = Math.max(w.start, earliest);
    for (const occ of occupied) {
      if (occ.end <= cursor) continue;
      if (occ.start >= w.end) break;
      if (occ.start > cursor && occ.start - cursor >= durationMs) {
        out.push({ start: cursor, end: occ.start });
      }
      if (occ.end > cursor) cursor = occ.end;
      if (cursor >= w.end) break;
    }
    if (w.end - cursor >= durationMs) out.push({ start: cursor, end: w.end });
  }
  return out;
}

/**
 * `mergeTimeEntries` — the union-not-sum timer-interval resolver (1.3 §7.10b).
 * PURE (§16). The SINGLE source of truth for effective hours.
 *
 * Two offline clock-ins on the same task produce overlapping (or duplicate)
 * intervals. Summing them double-counts time. This resolver unions the closed
 * intervals into disjoint canonical segments, so overlapping spans count ONCE:
 *   - `segments`        — the disjoint, sorted union of closed intervals,
 *   - `rawMinutes`      — the total union duration (no double-count),
 *   - `effectiveMinutes`— the union integrated against focus_factor, taking the
 *                         max focus over any instant covered by several entries,
 *   - `open`            — the still-running entries, earliest `started_at` first
 *                         (§7.10b keeps the earliest open; the §7.4 row-level
 *                         "which timer stays open" rule lives in timer-merge.ts).
 *
 * Properties (dedicated tests): union-not-sum, idempotency, order-independence.
 * The client "hide double timers" rule is a display projection of this, not a
 * second algorithm.
 */
import type { IsoDateTime, Uuid } from '../domain/primitives';
import { isoToEpochMillis } from '../time/instant';

export interface MergeableEntry {
  readonly id: Uuid;
  readonly started_at: IsoDateTime;
  readonly ended_at: IsoDateTime | null;
  readonly focus_factor?: number | null;
}

export interface TimeEntryUnion {
  /** Disjoint, ascending union of the closed intervals. */
  readonly segments: { readonly start: IsoDateTime; readonly end: IsoDateTime }[];
  /** Total union minutes (overlaps counted once). */
  readonly rawMinutes: number;
  /** Union minutes integrated against focus_factor (max focus per instant). */
  readonly effectiveMinutes: number;
  /** Still-open entries, or null when none is running. */
  readonly open: { readonly earliestStart: IsoDateTime; readonly entryIds: Uuid[] } | null;
}

interface Closed {
  startMs: number;
  endMs: number;
  startIso: IsoDateTime;
  endIso: IsoDateTime;
  focus: number;
}

const MS_PER_MIN = 60_000;

export function mergeTimeEntries(entries: readonly MergeableEntry[]): TimeEntryUnion {
  const closed: Closed[] = [];
  const openEntries: { id: Uuid; startMs: number; startIso: IsoDateTime }[] = [];

  for (const e of entries) {
    const startMs = isoToEpochMillis(e.started_at);
    if (e.ended_at === null) {
      openEntries.push({ id: e.id, startMs, startIso: e.started_at });
      continue;
    }
    const endMs = isoToEpochMillis(e.ended_at);
    if (endMs <= startMs) continue; // degenerate / invalid interval contributes nothing
    closed.push({ startMs, endMs, startIso: e.started_at, endIso: e.ended_at, focus: e.focus_factor ?? 1.0 });
  }

  // --- disjoint union segments (interval merge) ---
  const byStart = [...closed].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const segments: { start: IsoDateTime; end: IsoDateTime }[] = [];
  let cur: Closed | null = null;
  for (const iv of byStart) {
    if (cur === null) {
      cur = { ...iv };
    } else if (iv.startMs <= cur.endMs) {
      if (iv.endMs > cur.endMs) {
        cur.endMs = iv.endMs;
        cur.endIso = iv.endIso;
      }
    } else {
      segments.push({ start: cur.startIso, end: cur.endIso });
      cur = { ...iv };
    }
  }
  if (cur !== null) segments.push({ start: cur.startIso, end: cur.endIso });

  // --- raw + effective minutes via a boundary sweep (max focus per instant) ---
  const boundaries = Array.from(new Set(closed.flatMap((c) => [c.startMs, c.endMs]))).sort((a, b) => a - b);
  let rawMs = 0;
  let effMs = 0;
  for (let i = 0; i + 1 < boundaries.length; i += 1) {
    const lo = boundaries[i]!;
    const hi = boundaries[i + 1]!;
    let maxFocus = 0;
    let covered = false;
    for (const c of closed) {
      if (c.startMs <= lo && c.endMs >= hi) {
        covered = true;
        if (c.focus > maxFocus) maxFocus = c.focus;
      }
    }
    if (covered) {
      rawMs += hi - lo;
      effMs += (hi - lo) * maxFocus;
    }
  }

  const open = openEntries.length === 0
    ? null
    : {
        earliestStart: openEntries.reduce((a, b) => (b.startMs < a.startMs ? b : a)).startIso,
        entryIds: openEntries.map((o) => o.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      };

  return { segments, rawMinutes: rawMs / MS_PER_MIN, effectiveMinutes: effMs / MS_PER_MIN, open };
}

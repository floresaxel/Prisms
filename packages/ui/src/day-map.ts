/**
 * The day map (MOBILE_TODAY_PLAN D3) — the whole day as percentages.
 *
 * One selector feeds two surfaces: the 14 px bar down the right edge (T2) and
 * the swipe-out day calendar (T3). Rendering both from the same `DayMap` is why
 * they cannot fall out of step — a block cannot be amber in one and blue in the
 * other, because the state is decided once, here.
 *
 * D4: the greyed "inactive" zones are the *complement of the scheduler
 * windows*, not a new setting. Active hours are, by definition, the hours the
 * scheduler is allowed to place work in — so when windows become user-editable
 * the bar follows for free.
 *
 * The scale is a fixed civil day, midnight → midnight in the account's zone,
 * because that is what makes a 24 h bar legible. The day's *contents* are the
 * day-reset bucket, which is a slightly different interval — see
 * `minutesFromMidnight` for what happens at the seam.
 */
import { localInstant, type ConcreteWindow, type Instant, type IsoDate } from '@prisms/core';

import { projectTone, type DotTone } from './format';
import type { AgendaBlock } from './hooks';

/** `suggested` is decided by the block's status; the rest mirror the itinerary. */
export type DayMapState = 'done' | 'live' | 'upcoming' | 'suggested';

export interface DayMapSegment {
  blockId: string;
  taskId: string;
  title: string;
  /** Minutes from the day's midnight, on the fixed 0–1440 scale. */
  startMin: number;
  endMin: number;
  topPct: number;
  heightPct: number;
  tone: DotTone | 'grey';
  state: DayMapState;
  anchored: boolean;
  /** Minutes logged against the task today — the day panel labels blocks with it. */
  loggedMinutes: number;
}

export interface DayMapZone {
  topPct: number;
  heightPct: number;
}

export interface DayMap {
  segments: DayMapSegment[];
  /** Hours outside the scheduler windows, greyed out. */
  inactive: DayMapZone[];
  /** Where the red now-line sits, or null when `now` is not inside the day shown. */
  nowPct: number | null;
}

const DAY_MINUTES = 1440;
/** Below this a segment would round away to an invisible hairline. */
const MIN_SEGMENT_MINUTES = 6;

const toPct = (minutes: number): number => (minutes / DAY_MINUTES) * 100;

/**
 * Minutes from the day's midnight, clamped to the 0–1440 scale.
 *
 * Measuring from the day's own midnight (rather than reading a wall clock)
 * keeps the arithmetic monotonic, which matters at both seams: a DST day is 23
 * or 25 hours long, and the day-reset bucket reaches past civil midnight — a
 * block at 01:00 belongs to the day that has not reset yet, and clamps to the
 * bottom of the bar rather than jumping to the top. Chronological order along
 * the bar is preserved either way, which is the whole point of a timeline.
 */
function minutesFromMidnight(at: number, midnight: number): number {
  return Math.round((at - midnight) / 60_000);
}

/** Overlapping/adjacent [start,end) minute ranges → a sorted, merged list. */
function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

export function buildDayMap(args: {
  /** Already reduced to the day being shown (`blocksForDay`). */
  blocks: readonly AgendaBlock[];
  loggedMinutesByTask: ReadonlyMap<string, number>;
  /** Task → parent project id, for the tone. */
  projectIdByTask: ReadonlyMap<string, string | null>;
  /** `expandWindows(...)` output; anything outside the day is ignored. */
  windows: readonly ConcreteWindow[];
  runningTaskId: string | null;
  doneTaskIds: ReadonlySet<string>;
  now: Instant;
  /**
   * The day being drawn. Explicit rather than derived from `now` so the map can
   * render a day that is not today (T3's week strip) — and so `nowPct` has a
   * reason to be null.
   */
  today: IsoDate;
  timezone: string;
}): DayMap {
  const midnight = localInstant(args.today, 0, args.timezone);
  const nextMidnight = localInstant(args.today, 24, args.timezone);

  const segments: DayMapSegment[] = [];
  for (const block of args.blocks) {
    const rawStart = minutesFromMidnight(block.startsAt, midnight);
    const rawEnd = minutesFromMidnight(block.endsAt, midnight);

    // Clamped, never dropped. A block after civil midnight still belongs to
    // this day's bucket, so the itinerary lists it — dropping it here would
    // make the bar disagree with the list, which is the one thing sharing this
    // selector is meant to prevent. It lands in the bottom sliver instead.
    const startMin = Math.max(0, Math.min(DAY_MINUTES - MIN_SEGMENT_MINUTES, rawStart));
    const endMin = Math.min(DAY_MINUTES, Math.max(rawEnd, startMin + MIN_SEGMENT_MINUTES));
    const projectId = args.projectIdByTask.get(block.taskId) ?? null;

    segments.push({
      blockId: block.id,
      taskId: block.taskId,
      title: block.title,
      startMin,
      endMin,
      topPct: toPct(startMin),
      heightPct: toPct(endMin - startMin),
      tone: projectId === null ? 'grey' : projectTone(projectId),
      state:
        block.status === 'suggested'
          ? 'suggested'
          : args.doneTaskIds.has(block.taskId)
            ? 'done'
            : block.taskId === args.runningTaskId
              ? 'live'
              : 'upcoming',
      anchored: block.anchored,
      loggedMinutes: args.loggedMinutesByTask.get(block.taskId) ?? 0,
    });
  }
  segments.sort((a, b) =>
    a.startMin !== b.startMin ? a.startMin - b.startMin : a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0,
  );

  const active = mergeRanges(
    args.windows
      .map((w) => [Math.max(w.start, midnight), Math.min(w.end, nextMidnight)] as const)
      .filter(([start, end]) => end > start)
      .map(
        ([start, end]) =>
          [
            Math.max(0, minutesFromMidnight(start, midnight)),
            Math.min(DAY_MINUTES, minutesFromMidnight(end, midnight)),
          ] as const,
      ),
  );

  const inactive: DayMapZone[] = [];
  let cursor = 0;
  for (const [start, end] of active) {
    if (start > cursor) inactive.push({ topPct: toPct(cursor), heightPct: toPct(start - cursor) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < DAY_MINUTES) inactive.push({ topPct: toPct(cursor), heightPct: toPct(DAY_MINUTES - cursor) });

  const nowMin = minutesFromMidnight(args.now, midnight);
  const nowPct = nowMin >= 0 && nowMin <= DAY_MINUTES ? toPct(nowMin) : null;

  return { segments, inactive, nowPct };
}

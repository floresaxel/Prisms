/**
 * The Clocked part of a journal day, shaped for the collapsed card and the
 * "all logs" popup: one row per TASK with its day total, and a vertical bar of
 * the whole logical day with every clocked session drawn as a highlighted region.
 *
 * PURE — no clock, no DOM. The current instant comes in as `nowMs` (only running
 * sessions and the "now" marker need it), so the shapes are testable as plain data.
 *
 * The bar spans the LOGICAL day the day log uses: from the day-reset hour on
 * `date` to the same hour on the next date, in the user's zone — so a 23- or
 * 25-hour DST day is drawn as exactly that, and a session after midnight but
 * before the reset sits at the bottom of the day it belongs to.
 */
import {
  addDays,
  DEFAULT_TIMEZONE,
  formatDayLogTime,
  localInstant,
  type DayLogClockedEntry,
  type DayLogRef,
} from '@prisms/core';

/**
 * The zone to draw in: the user's, unless the platform does not know it (a
 * hand-edited setting), in which case the default — the day log itself falls
 * back the same way, so the bar and the log never disagree about the day.
 */
export function usableZone(timezone: string): string {
  try {
    localInstant('2026-01-01', 0, timezone);
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export interface DayBounds {
  startMs: number;
  endMs: number;
}

/** The logical day `date` covers: reset hour on `date` → reset hour on the next date. */
export function dayBounds(date: string, dayResetHour: number, timezone: string): DayBounds {
  return {
    startMs: localInstant(date, dayResetHour, timezone),
    endMs: localInstant(addDays(date, 1), dayResetHour, timezone),
  };
}

/** Task colours, in the order tasks first appear in the day. No red (that means danger). */
export const CLOCK_TONES = ['blue', 'teal', 'amber', 'green', 'sky', 'slate'] as const;
export type ClockTone = (typeof CLOCK_TONES)[number];

export interface ClockedTask {
  taskId: string;
  title: string;
  project: DayLogRef | null;
  vision: DayLogRef | null;
  /** Wall-clock minutes on THIS task (its own overlapping sessions counted once). */
  minutes: number;
  sessions: number;
  /** One of its sessions is still running (its time is not in `minutes` yet). */
  running: boolean;
  tone: ClockTone;
}

export interface ClockedSegment {
  entryId: string;
  taskId: string;
  /** Position on the bar as fractions of the day, 0 = top (day start). */
  top: number;
  height: number;
  /** Side-by-side placement while sessions overlap (split focus); 0 of 1 otherwise. */
  lane: number;
  lanes: number;
  running: boolean;
  tone: ClockTone;
}

export interface ClockedDay {
  tasks: ClockedTask[];
  segments: ClockedSegment[];
}

function ms(ts: string | null): number | null {
  if (ts === null) return null;
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

/** Minutes covered by a set of [start, end) spans, overlaps counted once. */
function unionMinutes(spans: [number, number][]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [s, t] of sorted) {
    if (cur === null || s > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [s, t];
    } else if (t > cur[1]) {
      cur[1] = t;
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / 60_000);
}

export function buildClockedDay(entries: readonly DayLogClockedEntry[], bounds: DayBounds, nowMs: number): ClockedDay {
  // tasks in the order they were first clocked, so colours read top-down like the bar
  const order: string[] = [];
  const byTask = new Map<string, DayLogClockedEntry[]>();
  const sorted = [...entries].sort((a, b) => (ms(a.started_at) ?? 0) - (ms(b.started_at) ?? 0));
  for (const e of sorted) {
    let list = byTask.get(e.task_id);
    if (!list) {
      list = [];
      byTask.set(e.task_id, list);
      order.push(e.task_id);
    }
    list.push(e);
  }
  const toneOf = new Map(order.map((id, i) => [id, CLOCK_TONES[i % CLOCK_TONES.length]!]));

  const tasks: ClockedTask[] = order.map((taskId) => {
    const list = byTask.get(taskId)!;
    const first = list[0]!;
    const spans: [number, number][] = [];
    for (const e of list) {
      const s = ms(e.started_at);
      const t = ms(e.ended_at);
      if (s !== null && t !== null && t > s) spans.push([s, t]);
    }
    return {
      taskId,
      title: first.title,
      project: first.project,
      vision: first.vision,
      minutes: unionMinutes(spans),
      sessions: list.length,
      running: list.some((e) => e.ended_at === null),
      tone: toneOf.get(taskId)!,
    };
  });

  // segments, clipped to the day; a running one runs to "now"
  const span = bounds.endMs - bounds.startMs;
  const raw: { e: DayLogClockedEntry; s: number; t: number }[] = [];
  for (const e of sorted) {
    const s0 = ms(e.started_at);
    if (s0 === null || span <= 0) continue;
    const t0 = e.ended_at === null ? nowMs : ms(e.ended_at);
    if (t0 === null) continue;
    const s = Math.max(s0, bounds.startMs);
    const t = Math.min(t0, bounds.endMs);
    if (t <= s) continue;
    raw.push({ e, s, t });
  }

  // Lanes: within each cluster of transitively-overlapping sessions, greedy
  // assignment to the first free lane; the cluster's width is split that many
  // ways. A session that overlaps nothing keeps the full width.
  const segments: ClockedSegment[] = [];
  let i = 0;
  while (i < raw.length) {
    let clusterEnd = raw[i]!.t;
    let j = i + 1;
    while (j < raw.length && raw[j]!.s < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, raw[j]!.t);
      j += 1;
    }
    const laneEnds: number[] = [];
    const placed: { r: (typeof raw)[number]; lane: number }[] = [];
    for (const r of raw.slice(i, j)) {
      let lane = laneEnds.findIndex((end) => end <= r.s);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(r.t);
      } else {
        laneEnds[lane] = r.t;
      }
      placed.push({ r, lane });
    }
    for (const { r, lane } of placed) {
      segments.push({
        entryId: r.e.entry_id,
        taskId: r.e.task_id,
        top: (r.s - bounds.startMs) / span,
        height: (r.t - r.s) / span,
        lane,
        lanes: laneEnds.length,
        running: r.e.ended_at === null,
        tone: toneOf.get(r.e.task_id)!,
      });
    }
    i = j;
  }

  return { tasks, segments };
}

export interface DayTick {
  /** 0 = top of the bar. */
  frac: number;
  label: string;
}

/**
 * Clock labels down the bar every `stepHours` of WALL time from the reset hour
 * (04:00, 10:00, 16:00, 22:00, 04:00 by default), placed by real instants so a
 * DST day's labels sit where those hours actually fall.
 */
export function dayTicks(date: string, dayResetHour: number, timezone: string, bounds: DayBounds, stepHours = 6): DayTick[] {
  const span = bounds.endMs - bounds.startMs;
  const ticks: DayTick[] = [];
  for (let k = 0; k * stepHours <= 24; k += 1) {
    const total = dayResetHour + k * stepHours;
    const at = localInstant(addDays(date, Math.floor(total / 24)), total % 24, timezone);
    ticks.push({ frac: span > 0 ? (at - bounds.startMs) / span : 0, label: formatDayLogTime(at, timezone) });
  }
  return ticks;
}

/** Where "now" sits on the bar, or null when now is not inside this day. */
export function nowFrac(bounds: DayBounds, nowMs: number): number | null {
  if (nowMs < bounds.startMs || nowMs >= bounds.endMs) return null;
  return (nowMs - bounds.startMs) / (bounds.endMs - bounds.startMs);
}

// --- highlighting -------------------------------------------------------------

/**
 * What is singled out: every session of one TASK (hovering a log or a task row),
 * or exactly one SESSION (clicking a log or a bar segment).
 */
export type ClockFocus = { kind: 'task'; taskId: string } | { kind: 'entry'; entryId: string; taskId: string } | null;

/**
 * How an item draws under the current focus. `on` = singled out, `dim` = greyed
 * because something else is, `none` = nothing is focused. A task ROW counts as on
 * when the focused session belongs to it; a session needs to match exactly.
 */
export function focusState(focus: ClockFocus, item: { taskId: string; entryId?: string }): 'on' | 'dim' | 'none' {
  if (focus === null) return 'none';
  if (focus.kind === 'task') return item.taskId === focus.taskId ? 'on' : 'dim';
  if (item.entryId === undefined) return item.taskId === focus.taskId ? 'on' : 'dim';
  return item.entryId === focus.entryId ? 'on' : 'dim';
}

/**
 * The Today itinerary (MOBILE_TODAY_PLAN §2 #2–#10) as pure functions.
 *
 * React Native components are not rendered in this repo's tests, so anything
 * that can be got wrong lives here instead of in the screen: which blocks count
 * as "today", which state a row is in, and which duration it shows. T2's
 * `buildDayMap` renders the same day at a different scale and reuses
 * `loggedMinutesByTask` so the bar and the list can never disagree.
 */
import { bucketDate, type Instant, type IsoDate } from '@prisms/core';

import { projectTone, type DotTone } from './format';
import type { AgendaBlock, AgendaEntry } from './hooks';
import type { ProvenanceFields } from './provenance';

/** `done` wins over `live`: a finished task is finished even if a timer is still open on it. */
export type ItineraryState = 'done' | 'live' | 'upcoming';

const wallClockCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = wallClockCache.get(timezone);
  if (cached !== undefined) return cached;
  // `hour12: false` rather than `hourCycle` for the widest engine support; some
  // engines then render midnight as "24", which `minutesOfDay` normalises.
  const made = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  wallClockCache.set(timezone, made);
  return made;
}

/**
 * Minutes since local midnight (0..1439) on the account's wall clock. The day
 * map (T2) positions segments with this, and the itinerary labels rows with it,
 * so both read the same clock the scheduler windows are written against.
 */
export function minutesOfDay(at: Instant, timezone: string): number {
  const parts = wallClockFormatter(timezone).formatToParts(new Date(at));
  const read = (type: 'hour' | 'minute'): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ((read('hour') % 24) * 60 + read('minute')) % 1440;
}

/** `7:00` / `14:30` — the itinerary's left-hand time column. */
export function formatWallTime(at: Instant, timezone: string): string {
  const total = minutesOfDay(at, timezone);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface ItineraryRow {
  blockId: string;
  taskId: string;
  title: string;
  startsAt: Instant;
  endsAt: Instant;
  state: ItineraryState;
  /** Parent project's colour; `grey` when the task hangs under no project. */
  tone: DotTone | 'grey';
  projectId: string | null;
  /** I7 anchored — immovable, shows a lock. */
  anchored: boolean;
  /** The task exists because of a habit (`habit_id`) — renders a HABIT chip. */
  isHabit: boolean;
  /** Minutes actually logged against this task today. */
  loggedMinutes: number;
  /** The estimate, falling back to how long the block itself is. */
  plannedMinutes: number;
  /** §7.8 "why is this here?". */
  provenance: ProvenanceFields;
}

/** The day a block belongs to (day-reset aware). One definition, used by the list and the bar. */
export interface DayBucketOptions {
  today: IsoDate;
  timezone: string;
  dayResetHour: number;
}

/**
 * The blocks belonging to `today`'s bucket — committed AND suggested. The
 * itinerary then drops the suggestions; the day map keeps them.
 */
export function blocksForDay(blocks: readonly AgendaBlock[], opts: DayBucketOptions): AgendaBlock[] {
  return blocks.filter((b) => bucketDate(b.startsAt, opts.dayResetHour, opts.timezone) === opts.today);
}

/**
 * Minutes logged per task within today's bucket. Entries are clipped to the
 * bucket, so a session that runs across the day-reset counts only the part that
 * belongs to the day being shown.
 */
export function loggedMinutesByTask(entries: readonly AgendaEntry[], opts: DayBucketOptions): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (bucketDate(e.startsAt, opts.dayResetHour, opts.timezone) !== opts.today) continue;
    const minutes = Math.max(0, Math.round((e.endsAt - e.startsAt) / 60_000));
    if (minutes === 0) continue;
    out.set(e.taskId, (out.get(e.taskId) ?? 0) + minutes);
  }
  return out;
}

/** Today's committed blocks, in clock order, each resolved to a renderable row. */
export function buildItinerary(args: {
  blocks: readonly AgendaBlock[];
  logged: ReadonlyMap<string, number>;
  estimateMinutesByTask: ReadonlyMap<string, number>;
  /** Task → its parent project id (null when it has none). */
  projectIdByTask: ReadonlyMap<string, string | null>;
  /** Tasks whose `completed_at` is set. */
  doneTaskIds: ReadonlySet<string>;
  /** Tasks carrying a `habit_id` — including done ones, which keep the chip. */
  habitTaskIds: ReadonlySet<string>;
  runningTaskId: string | null;
  today: IsoDate;
  timezone: string;
  dayResetHour: number;
}): ItineraryRow[] {
  const rows: ItineraryRow[] = [];
  const today = blocksForDay(args.blocks, args);

  for (const block of today) {
    // Suggestions are not part of the itinerary — they live in the day panel
    // (T3), where they can be accepted or rejected.
    if (block.status !== 'committed') continue;

    const projectId = args.projectIdByTask.get(block.taskId) ?? null;
    const blockMinutes = Math.max(0, Math.round((block.endsAt - block.startsAt) / 60_000));

    rows.push({
      blockId: block.id,
      taskId: block.taskId,
      title: block.title,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      state: args.doneTaskIds.has(block.taskId) ? 'done' : block.taskId === args.runningTaskId ? 'live' : 'upcoming',
      tone: projectId === null ? 'grey' : projectTone(projectId),
      projectId,
      anchored: block.anchored,
      isHabit: args.habitTaskIds.has(block.taskId),
      loggedMinutes: args.logged.get(block.taskId) ?? 0,
      plannedMinutes: args.estimateMinutesByTask.get(block.taskId) ?? blockMinutes,
      provenance: block.provenance,
    });
  }

  return rows.sort((a, b) =>
    a.startsAt !== b.startsAt ? a.startsAt - b.startsAt : a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0,
  );
}

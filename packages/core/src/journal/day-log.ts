/**
 * Journal day log (Annex L) — the read-only "Day log" footer under each journal
 * day, DERIVED from facts the caller already holds. There is no `day_logs` table
 * and no writer anywhere in the system: this module is the whole feature, called
 * at client render (`useDayLog`) and at server export time (`runJournalExport`).
 *
 * Consequences that are load-bearing, not incidental:
 * - The log is a snapshot of CURRENT facts, never history. Unchecking a task
 *   removes its line; renaming updates the title; deleting erases it everywhere.
 * - Day assignment goes through `bucketDate` and nothing else (§7.2): a block
 *   belongs to the day of `starts_at` (one crossing the reset hour stays on its
 *   start day), a completion to the day of `completed_at`. Changing the timezone
 *   or day-reset hour therefore re-buckets EVERY day at the next render.
 * - PURE (§16): no wall clock, no IO. The output depends on `date`, never `now`.
 * - TOTAL over dirty rows: a malformed timestamp, an absent title, or an unknown
 *   timezone filters the row (or falls back) instead of throwing. The footer must
 *   never be able to break a journal page.
 */
import { z } from 'zod';

import {
  completionDispositionSchema,
  type CompletionDisposition,
  type Node,
  type ScheduleBlock,
} from '../domain/entities';
import {
  isoDateTimeSchema,
  uuidSchema,
  type IsoDate,
  type IsoDateTime,
  type Uuid,
} from '../domain/primitives';
import { DEFAULT_DAY_RESET_HOUR, DEFAULT_TIMEZONE } from '../status/context';
import { bucketDate, localParts } from '../time/bucket';
import { asEpochMillis, type EpochMillis } from '../time/instant';

/** Envelope version of the computed shape (bumped only on a breaking change). */
export const DAY_LOG_VERSION = 1;

/** Per-list cap: determinism over completeness (D2). Overflow becomes `truncated`. */
export const DAY_LOG_MAX_ENTRIES = 100;

/** JS `Date` is only defined within ±8.64e15 ms of the epoch; beyond that Intl throws. */
const MAX_EPOCH_MS = 8.64e15;

export const dayLogScheduledEntrySchema = z.strictObject({
  block_id: uuidSchema,
  task_id: uuidSchema,
  title: z.string(),
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
  /** The task is complete RIGHT NOW (any day) — not "completed inside this block". */
  done: z.boolean(),
});
export type DayLogScheduledEntry = z.infer<typeof dayLogScheduledEntrySchema>;

export const dayLogCompletedEntrySchema = z.strictObject({
  task_id: uuidSchema,
  title: z.string(),
  completed_at: isoDateTimeSchema,
  disposition: completionDispositionSchema,
  /** The task had a live committed block bucketed to this same day. */
  planned: z.boolean(),
});
export type DayLogCompletedEntry = z.infer<typeof dayLogCompletedEntrySchema>;

export const dayLogEntriesSchema = z.strictObject({
  v: z.literal(DAY_LOG_VERSION),
  scheduled: z.array(dayLogScheduledEntrySchema),
  completed: z.array(dayLogCompletedEntrySchema),
  /** Present only when a list overflowed the cap; counts the DROPPED rows. */
  truncated: z
    .strictObject({
      scheduled: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
    })
    .optional(),
});
export type DayLogEntries = z.infer<typeof dayLogEntriesSchema>;

/** Day-assignment settings; each field falls back to the §6.0 DDL default. */
export interface DayLogSettings {
  dayResetHour?: number | null;
  timezone?: string | null;
}

/**
 * The fields the computation actually reads. Declared as the minimum so a caller
 * can pass full rows (the client's merged replica) OR a narrow projection (the
 * export's SELECT), without a widening cast in either direction.
 */
export type DayLogNode = Pick<
  Node,
  'id' | 'deleted_at' | 'title' | 'completed_at' | 'completion_disposition'
>;
export type DayLogBlock = Pick<
  ScheduleBlock,
  'id' | 'task_id' | 'status' | 'starts_at' | 'ends_at' | 'superseded_at' | 'deleted_at'
>;

/** Fact rows. Callers may pass supersets — this module filters and buckets. */
export interface DayLogFacts {
  nodes: Iterable<DayLogNode>;
  blocks: Iterable<DayLogBlock>;
}

export interface DayLogInput extends DayLogFacts, DayLogSettings {
  date: IsoDate;
}

// --- day assignment ---------------------------------------------------------

interface ResolvedSettings {
  dayResetHour: number;
  timezone: string;
}

const zoneUsable = new Map<string, boolean>();

/** An IANA zone the platform actually knows — an unknown one makes Intl throw. */
function isUsableTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  const cached = zoneUsable.get(tz);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    localParts(asEpochMillis(0), tz);
  } catch {
    ok = false;
  }
  zoneUsable.set(tz, ok);
  return ok;
}

function resolveSettings(settings: DayLogSettings): ResolvedSettings {
  const hour = settings.dayResetHour;
  return {
    dayResetHour:
      typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
        ? hour
        : DEFAULT_DAY_RESET_HOUR,
    timezone: isUsableTimeZone(settings.timezone) ? settings.timezone : DEFAULT_TIMEZONE,
  };
}

/** Epoch ms for a row timestamp, or null when the row is unusable (totality). */
function epochOf(ts: unknown): number | null {
  if (typeof ts === 'number') {
    return Number.isFinite(ts) && Math.abs(ts) <= MAX_EPOCH_MS ? ts : null;
  }
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) || Math.abs(ms) > MAX_EPOCH_MS ? null : ms;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idOf(value: unknown): Uuid | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// --- the computation --------------------------------------------------------

interface Draft {
  scheduled: { ms: number; entry: DayLogScheduledEntry }[];
  completed: { ms: number; entry: DayLogCompletedEntry }[];
  /** Task ids holding a live committed block on this day — the `planned` marker. */
  plannedTaskIds: Set<Uuid>;
}

function draft(): Draft {
  return { scheduled: [], completed: [], plannedTaskIds: new Set() };
}

/**
 * One pass over the facts, grouped by bucket date. `onlyDate` narrows to a single
 * day; passing null groups every day — so `computeDayLog` and
 * `computeDayLogsByDate` cannot drift (property-tested).
 */
function collect(
  facts: DayLogFacts,
  resolved: ResolvedSettings,
  onlyDate: IsoDate | null,
): Map<IsoDate, Draft> {
  const drafts = new Map<IsoDate, Draft>();
  const draftFor = (date: IsoDate): Draft => {
    const existing = drafts.get(date);
    if (existing) return existing;
    const created = draft();
    drafts.set(date, created);
    return created;
  };
  const bucketOf = (ms: number): IsoDate =>
    bucketDate(ms as EpochMillis, resolved.dayResetHour, resolved.timezone);

  // Live nodes, indexed once: `nodes` may be a one-shot iterator, so it is walked
  // exactly once and the map is the input to the completed pass below.
  const liveNodes = new Map<Uuid, DayLogNode>();
  for (const node of facts.nodes) {
    if (!node || node.deleted_at !== null) continue;
    const id = idOf(node.id);
    if (id === null) continue;
    liveNodes.set(id, node);
  }

  // Pass 1 — live committed blocks, joined to their live node.
  for (const block of facts.blocks) {
    if (!block) continue;
    if (block.status !== 'committed' || block.superseded_at !== null || block.deleted_at !== null) {
      continue;
    }
    const blockId = idOf(block.id);
    const taskId = idOf(block.task_id);
    if (blockId === null || taskId === null) continue;
    const startsMs = epochOf(block.starts_at);
    if (startsMs === null || epochOf(block.ends_at) === null) continue;
    const date = bucketOf(startsMs);
    if (onlyDate !== null && date !== onlyDate) continue;
    const node = liveNodes.get(taskId);
    if (node === undefined) continue;
    const target = draftFor(date);
    target.plannedTaskIds.add(taskId);
    target.scheduled.push({
      ms: startsMs,
      entry: {
        block_id: blockId,
        task_id: taskId,
        title: textOf(node.title),
        starts_at: block.starts_at,
        ends_at: block.ends_at,
        done: node.completed_at !== null,
      },
    });
  }

  // Pass 2 — completions. Runs after every block is bucketed so `planned` reads a
  // fully-populated set.
  for (const [taskId, node] of liveNodes) {
    if (node.completed_at === null) continue;
    const completedMs = epochOf(node.completed_at);
    if (completedMs === null) continue;
    const date = bucketOf(completedMs);
    if (onlyDate !== null && date !== onlyDate) continue;
    const target = draftFor(date);
    target.completed.push({
      ms: completedMs,
      entry: {
        task_id: taskId,
        title: textOf(node.title),
        completed_at: node.completed_at,
        disposition: dispositionOf(node.completion_disposition),
        planned: target.plannedTaskIds.has(taskId),
      },
    });
  }

  return drafts;
}

function dispositionOf(value: unknown): CompletionDisposition {
  return value === 'obsolete' ? 'obsolete' : 'completed';
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic order + cap. Returns null for an empty day (D1: null = no footer). */
function finalize(source: Draft): DayLogEntries | null {
  if (source.scheduled.length === 0 && source.completed.length === 0) return null;
  const scheduled = [...source.scheduled]
    .sort((a, b) => a.ms - b.ms || compareIds(a.entry.block_id, b.entry.block_id))
    .map((s) => s.entry);
  const completed = [...source.completed]
    .sort((a, b) => a.ms - b.ms || compareIds(a.entry.task_id, b.entry.task_id))
    .map((c) => c.entry);
  const droppedScheduled = Math.max(0, scheduled.length - DAY_LOG_MAX_ENTRIES);
  const droppedCompleted = Math.max(0, completed.length - DAY_LOG_MAX_ENTRIES);
  const entries: DayLogEntries = {
    v: DAY_LOG_VERSION,
    scheduled: scheduled.slice(0, DAY_LOG_MAX_ENTRIES),
    completed: completed.slice(0, DAY_LOG_MAX_ENTRIES),
  };
  if (droppedScheduled > 0 || droppedCompleted > 0) {
    entries.truncated = { scheduled: droppedScheduled, completed: droppedCompleted };
  }
  return entries;
}

/** The day log for ONE day, or null when the day holds nothing to log. */
export function computeDayLog(input: DayLogInput): DayLogEntries | null {
  const resolved = resolveSettings(input);
  const drafts = collect(input, resolved, input.date);
  const found = drafts.get(input.date);
  return found ? finalize(found) : null;
}

/**
 * Every non-empty day in one pass — what the export uses, so a full archive costs
 * one traversal instead of one per day.
 */
export function computeDayLogsByDate(
  facts: DayLogFacts,
  settings: DayLogSettings = {},
): Map<IsoDate, DayLogEntries> {
  const resolved = resolveSettings(settings);
  const out = new Map<IsoDate, DayLogEntries>();
  for (const [date, source] of collect(facts, resolved, null)) {
    const entries = finalize(source);
    if (entries !== null) out.set(date, entries);
  }
  return out;
}

/** True when the log has no lines at all (what `computeDayLog` reports as null). */
export function isDayLogEmpty(entries: DayLogEntries | null | undefined): boolean {
  return !entries || (entries.scheduled.length === 0 && entries.completed.length === 0);
}

// --- rendering --------------------------------------------------------------

export interface DayLogRenderOptions {
  timezone?: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `HH:mm` in the user's zone, via the same cached Intl.DateTimeFormat that
 * `bucketDate` uses — nothing from the Intl surface Hermes lacks, which the
 * mobile hermes-compat guard greps for. Unusable timestamps render `--:--`.
 */
export function formatDayLogTime(
  ts: EpochMillis | IsoDateTime,
  timezone?: string | null,
): string {
  const ms = epochOf(ts);
  if (ms === null) return '--:--';
  const zone = isUsableTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const { hour, minute } = localParts(ms as EpochMillis, zone);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Titles are user prose: flatten newlines so one can't break out of the list. */
function inlineTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat : '(untitled)';
}

export const DAY_LOG_HEADING = '### Day log';
/** The deterministic boundary a future importer could strip on (D7). */
export const DAY_LOG_SEPARATOR = '\n\n---\n\n';

/**
 * The markdown form of a day log — the ONLY textual rendering, shared by the day
 * `.md` download, the archive zip, and mobile Share, so the surfaces cannot drift.
 */
export function renderDayLogMarkdown(
  entries: DayLogEntries,
  options: DayLogRenderOptions = {},
): string {
  const tz = options.timezone;
  const lines: string[] = [DAY_LOG_HEADING];
  const dropped = entries.truncated;
  if (entries.scheduled.length > 0) {
    lines.push('', '**Scheduled**', '');
    for (const s of entries.scheduled) {
      const range = `${formatDayLogTime(s.starts_at, tz)}–${formatDayLogTime(s.ends_at, tz)}`;
      lines.push(`- [${s.done ? 'x' : ' '}] ${range} ${inlineTitle(s.title)}`);
    }
    if (dropped && dropped.scheduled > 0) lines.push(`- +${dropped.scheduled} more`);
  }
  if (entries.completed.length > 0) {
    lines.push('', '**Completed**', '');
    for (const c of entries.completed) {
      const marks = [
        c.planned ? '' : '(unplanned)',
        c.disposition === 'obsolete' ? '(descoped)' : '',
      ].filter((m) => m.length > 0);
      const suffix = marks.length > 0 ? ` ${marks.join(' ')}` : '';
      lines.push(`- ${formatDayLogTime(c.completed_at, tz)} ${inlineTitle(c.title)}${suffix}`);
    }
    if (dropped && dropped.completed > 0) lines.push(`- +${dropped.completed} more`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A day's export bytes: the note `content` VERBATIM, then the day-log section.
 * `content` is always a prefix of the result — the journal `.md` contract (D7)
 * survives the append, and an empty note yields the section alone (a log-only day).
 */
export function composeDayMarkdown(
  content: string,
  entries: DayLogEntries | null | undefined,
  options: DayLogRenderOptions = {},
): string {
  const body = typeof content === 'string' ? content : '';
  if (isDayLogEmpty(entries)) return body;
  const section = renderDayLogMarkdown(entries as DayLogEntries, options);
  return body.length === 0 ? section : `${body}${DAY_LOG_SEPARATOR}${section}`;
}

/**
 * journal.export (D7): all of a user's LIVE journal notes, ordered by day, for
 * the per-day `.md` archive. Server-sourced ON PURPOSE — under the lazy
 * `journal_month` sync stream (§7.3) a device may hold only the months it has
 * viewed, so a client-side "export all" from the local replica would silently
 * truncate. JSON only (the client packages the `.md` files / zip); owner-scoped,
 * live rows only, no secrets.
 *
 * Annex L: when `user_settings.journal_day_log` is on, each day also carries its
 * DERIVED day log, and days holding only a log (facts but no note) join the
 * response — the archive shows what the journal shows. Nothing is stored: the
 * logs are computed here from the same core function the UI renders with, so the
 * two forms cannot drift. The server ships STRUCTURE, never rendered markdown.
 *
 * With the flag off the response is byte-identical to the pre-Annex-L one
 * (golden-compared in the integration suite).
 */
import {
  computeDayLogsByDate,
  DEFAULT_DAY_RESET_HOUR,
  DEFAULT_JOURNAL_DAY_LOG,
  DEFAULT_TIMEZONE,
  type DayLogEntries,
} from '@prisms/core';
import { breaks, journal_entries, nodes, schedule_blocks, time_entries, timezone_changes, user_settings } from '@prisms/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface JournalExportEntry {
  entry_date: string;
  content: string;
  /** The NOTE's updated_at. Absent on a log-only day — there is no note row. */
  updated_at?: string;
  /** Annex L. Absent when the flag is off or the day has nothing to log. */
  day_log?: DayLogEntries;
}

export async function runJournalExport(db: PostgresJsDatabase, userId: string): Promise<JournalExportEntry[]> {
  const notes = await db
    .select({
      entry_date: journal_entries.entry_date,
      content: journal_entries.content,
      updated_at: journal_entries.updated_at,
    })
    .from(journal_entries)
    .where(and(eq(journal_entries.user_id, userId), isNull(journal_entries.deleted_at)))
    .orderBy(asc(journal_entries.entry_date));

  const [settings] = await db
    .select({
      day_reset_hour: user_settings.day_reset_hour,
      timezone: user_settings.timezone,
      journal_day_log: user_settings.journal_day_log,
    })
    .from(user_settings)
    .where(eq(user_settings.user_id, userId))
    .limit(1);

  // A user who has never written settings gets the DDL defaults — the feature is
  // opt-OUT, so "no row" means ON.
  if (!(settings?.journal_day_log ?? DEFAULT_JOURNAL_DAY_LOG)) return notes;

  const liveCommittedBlocks = and(
    eq(schedule_blocks.user_id, userId),
    eq(schedule_blocks.status, 'committed'),
    isNull(schedule_blocks.superseded_at),
    isNull(schedule_blocks.deleted_at),
  );
  const blocks = await db
    .select({
      id: schedule_blocks.id,
      task_id: schedule_blocks.task_id,
      status: schedule_blocks.status,
      starts_at: schedule_blocks.starts_at,
      ends_at: schedule_blocks.ends_at,
      superseded_at: schedule_blocks.superseded_at,
      deleted_at: schedule_blocks.deleted_at,
    })
    .from(schedule_blocks)
    .where(liveCommittedBlocks);

  // Every live node, not just the ones a line names: the project / vision a line
  // rolls up to is found by walking UP from the task, so the ancestors must be
  // here too. One user's tree is small next to the rows already read above.
  const factNodes = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      parent_id: nodes.parent_id,
      node_type: nodes.node_type,
      completed_at: nodes.completed_at,
      completion_disposition: nodes.completion_disposition,
      deleted_at: nodes.deleted_at,
    })
    .from(nodes)
    .where(and(eq(nodes.user_id, userId), isNull(nodes.deleted_at)));

  const timeEntryRows = await db
    .select({
      id: time_entries.id,
      task_id: time_entries.task_id,
      started_at: time_entries.started_at,
      ended_at: time_entries.ended_at,
      deleted_at: time_entries.deleted_at,
    })
    .from(time_entries)
    .where(and(eq(time_entries.user_id, userId), isNull(time_entries.deleted_at)));
  // finished breaks — a day-log event of the day each one started on
  const breakRows = await db
    .select({ id: breaks.id, started_at: breaks.started_at, ended_at: breaks.ended_at, planned_minutes: breaks.planned_minutes, deleted_at: breaks.deleted_at })
    .from(breaks)
    .where(and(eq(breaks.user_id, userId), isNull(breaks.deleted_at)));
  // timezone changes — a note beside the day's logs, on the day each happened
  const zoneRows = await db
    .select({ id: timezone_changes.id, changed_at: timezone_changes.changed_at, from_timezone: timezone_changes.from_timezone, to_timezone: timezone_changes.to_timezone, cause: timezone_changes.cause, deleted_at: timezone_changes.deleted_at })
    .from(timezone_changes)
    .where(and(eq(timezone_changes.user_id, userId), isNull(timezone_changes.deleted_at)));
  const logs = computeDayLogsByDate(
    {
      nodes: factNodes,
      blocks,
      timeEntries: timeEntryRows,
      // ISO instants, as the day-log entry schema declares (the driver hands back Postgres' text form)
      breaks: breakRows.map((b) => ({ ...b, started_at: new Date(b.started_at).toISOString(), ended_at: new Date(b.ended_at).toISOString() })),
      timezoneChanges: zoneRows.map((c) => ({ ...c, changed_at: new Date(c.changed_at).toISOString() })),
    },
    {
      dayResetHour: settings?.day_reset_hour ?? DEFAULT_DAY_RESET_HOUR,
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
    },
  );
  if (logs.size === 0) return notes;

  const byDate = new Map<string, JournalExportEntry>();
  for (const note of notes) byDate.set(note.entry_date, note);
  for (const [entry_date, day_log] of logs) {
    const existing = byDate.get(entry_date);
    if (existing) existing.day_log = day_log;
    // A LOG-ONLY day: facts happened, the user wrote nothing. It belongs in the
    // archive because the journal page for that day shows the footer.
    else byDate.set(entry_date, { entry_date, content: '', day_log });
  }
  return [...byDate.values()].sort((a, b) =>
    a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0,
  );
}

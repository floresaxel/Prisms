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
import { journal_entries, nodes, schedule_blocks, user_settings } from '@prisms/db';
import { and, asc, eq, isNotNull, isNull, inArray, or } from 'drizzle-orm';
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

  // Only the nodes the log can name: the completions themselves, plus whatever a
  // committed block points at (a scheduled task need not be done — it renders as
  // an unchecked line, and without its row there would be no title to render).
  const factNodes = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      completed_at: nodes.completed_at,
      completion_disposition: nodes.completion_disposition,
      deleted_at: nodes.deleted_at,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.user_id, userId),
        isNull(nodes.deleted_at),
        or(
          isNotNull(nodes.completed_at),
          inArray(
            nodes.id,
            db.select({ task_id: schedule_blocks.task_id }).from(schedule_blocks).where(liveCommittedBlocks),
          ),
        ),
      ),
    );

  const logs = computeDayLogsByDate(
    { nodes: factNodes, blocks },
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

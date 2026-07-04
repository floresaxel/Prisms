/**
 * journal.export (D7): all of a user's LIVE journal notes, ordered by day, for
 * the per-day `.md` archive. Server-sourced ON PURPOSE — under the lazy
 * `journal_month` sync stream (§7.3) a device may hold only the months it has
 * viewed, so a client-side "export all" from the local replica would silently
 * truncate. JSON only (the client packages the `.md` files / zip); owner-scoped,
 * live rows only, no secrets.
 */
import { journal_entries } from '@prisms/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface JournalExportEntry {
  entry_date: string;
  content: string;
  updated_at: string;
}

export async function runJournalExport(db: PostgresJsDatabase, userId: string): Promise<JournalExportEntry[]> {
  return db
    .select({
      entry_date: journal_entries.entry_date,
      content: journal_entries.content,
      updated_at: journal_entries.updated_at,
    })
    .from(journal_entries)
    .where(and(eq(journal_entries.user_id, userId), isNull(journal_entries.deleted_at)))
    .orderBy(asc(journal_entries.entry_date));
}

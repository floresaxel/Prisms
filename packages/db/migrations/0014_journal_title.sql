-- An editable title for a day's note.
--
-- Empty string = untitled, which every existing row is; clients render the
-- default ("Note · <date>") for those rather than storing it, so the default can
-- change later without rewriting history, and an untitled note stays untitled
-- rather than silently acquiring a stale literal.
--
-- Like 0012 and 0013 this is one ALTER TABLE on an already-synced table: the
-- stream queries are `SELECT *`, so no sync-rule or publication change, and the
-- table list stays at 32 (packages/db/test/integration.test.ts).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';

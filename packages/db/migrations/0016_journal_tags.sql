-- Free-text tags on a day's note, so notes can be grouped and filtered by them.
--
-- A JSON array of canonical tag strings (lower-cased, trimmed, de-duplicated —
-- `normalizeJournalTags` in @prisms/core, applied by the server before it stores).
-- '[]' = untagged, which every existing row is. jsonb, like nodes.attributes, so
-- PowerSync ships it as JSON text and the client parses it the same way.
--
-- Not the confirmable-event `tags` catalog: that is a different feature (yes/no
-- answers on schedule blocks). These live on the note's own row, so tagging two
-- DIFFERENT days from two devices never contends, and the list is one per-field
-- last-writer-wins value.
--
-- Like 0012-0014 this is one ALTER TABLE on an already-synced table: the stream
-- queries are `SELECT *`, so no sync-rule or publication change, and the table
-- list stays at 32 (packages/db/test/integration.test.ts).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

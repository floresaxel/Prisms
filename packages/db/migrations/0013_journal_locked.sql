-- Per-day note lock, shared across devices.
--
-- The lock says "this day's note is read-only"; it used to be a web-only
-- localStorage flag, so it did not follow the user to another browser, the
-- desktop shell or the phone. It belongs on the day's own row: the natural key
-- is already (user_id, entry_date), and a per-row column inherits the per-field
-- HLC last-writer resolution in `command_field_versions` — so two devices
-- locking two DIFFERENT days never contend, which a set-of-dates in one
-- `user_settings` field could not have offered.
--
-- Like migration 0012 this is one ALTER TABLE on an already-synced table: the
-- `journal_month` / history sync-stream queries are `SELECT *`, so the column
-- rides along with no sync-rule or publication change, and the table list stays
-- at 32 (packages/db/test/integration.test.ts).
--
-- Existing rows default to UNLOCKED, which is what every note was before this.
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

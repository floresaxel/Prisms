-- Split focus: up to five timers may run at once, at most one per task.
--
-- I5 used to be "one open time entry per user", backstopped by a partial unique
-- index on (user_id). It is now "at most one open entry per (user, task), and at
-- most MAX_OPEN_TIMERS (5) open per user". The per-task half stays a DB backstop
-- by widening the index to (user_id, task_id); the count limit is checked by the
-- dispatcher (a partial unique index can't count), like the other I-rules that
-- need more than one row.
--
-- Logged time while timers overlap is split equally at READ time
-- (core splitConcurrent), so no column changes and no rewrite of history.
-- Index-only change on an already-synced table: no sync-rule or publication
-- change, and the table list stays at 32 (packages/db/test/integration.test.ts).
DROP INDEX IF EXISTS "entries_open";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entries_open" ON "time_entries" USING btree ("user_id", "task_id") WHERE "time_entries"."ended_at" IS NULL AND "time_entries"."deleted_at" IS NULL;

-- Long sessions: a timer left running > 6 h gets a `long_session` review item
-- ("was that intentional?"), and one left running > 24 h is clocked out by the
-- timer.long_session_scan job, also with a review item. Only the item_type
-- CHECK widens; no new table or column, so no sync-rule or publication change
-- and the table list stays at 32 (packages/db/test/integration.test.ts).
ALTER TABLE "sync_review_items" DROP CONSTRAINT IF EXISTS "review_items_type_check";
--> statement-breakpoint
ALTER TABLE "sync_review_items" ADD CONSTRAINT "review_items_type_check" CHECK ("sync_review_items"."item_type" IN ('command_rejection','dependency_rejection','hlc_conflict','stale_suggestion','automation_backstop','automation_drift','schema_version_block','import_warning','sync_warning','long_session'));

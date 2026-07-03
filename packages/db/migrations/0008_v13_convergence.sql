CREATE TABLE "schedule_suggestion_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_by_command_id" uuid,
	"last_modified_by_command_id" uuid,
	"source_kind" text DEFAULT 'legacy' NOT NULL,
	"source_id" uuid,
	"source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"horizon_start" timestamp with time zone NOT NULL,
	"horizon_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "suggestion_batches_source_check" CHECK ("schedule_suggestion_batches"."source" IN ('past_due','nightly_optimize','manual_optimize'))
);
--> statement-breakpoint
CREATE TABLE "sync_review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_by_command_id" uuid,
	"last_modified_by_command_id" uuid,
	"source_kind" text DEFAULT 'legacy' NOT NULL,
	"source_id" uuid,
	"source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"command_id" uuid,
	"item_type" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "review_items_type_check" CHECK ("sync_review_items"."item_type" IN ('command_rejection','dependency_rejection','hlc_conflict','stale_suggestion','automation_backstop','automation_drift','schema_version_block','import_warning','sync_warning')),
	CONSTRAINT "review_items_severity_check" CHECK ("sync_review_items"."severity" IN ('info','warning','error')),
	CONSTRAINT "review_items_status_check" CHECK ("sync_review_items"."status" IN ('open','resolved','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "computed_aggregates" DROP CONSTRAINT "computed_aggregates_subject_metric_uq";--> statement-breakpoint
ALTER TABLE "decision_scores" DROP CONSTRAINT "decision_scores_criterion_project_uq";--> statement-breakpoint
ALTER TABLE "diagram_layouts" DROP CONSTRAINT "diagram_layouts_diagram_node_uq";--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_pred_succ_uq";--> statement-breakpoint
ALTER TABLE "habit_completions" DROP CONSTRAINT "habit_completions_habit_occurrence_uq";--> statement-breakpoint
ALTER TABLE "sprint_memberships" DROP CONSTRAINT "sprint_memberships_sprint_node_uq";--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "rule_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "blocker_rules" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "command_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "client_version" text;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "effects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "parent_command_id" uuid;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "triggering_command_id" uuid;--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "depends_on" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "computed_aggregates" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_boards" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_groups" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "external_facts" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "suggestion_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "replaces_block_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_answers" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "hlc" text DEFAULT '000000000000-0000-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "created_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "last_modified_by_command_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "source_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "source_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "suggestion_batches_user" ON "schedule_suggestion_batches" USING btree ("user_id","computed_at") WHERE "schedule_suggestion_batches"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "review_items_user_status" ON "sync_review_items" USING btree ("user_id","status") WHERE "sync_review_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "computed_aggregates_user_metric_uq" ON "computed_aggregates" USING btree ("user_id","subject_kind","metric") WHERE "computed_aggregates"."subject_id" IS NULL AND "computed_aggregates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "computed_aggregates_subject_metric_uq" ON "computed_aggregates" USING btree ("user_id","subject_kind","subject_id","metric") WHERE "computed_aggregates"."subject_id" IS NOT NULL AND "computed_aggregates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_scores_criterion_project_uq" ON "decision_scores" USING btree ("criterion_id","project_id") WHERE "decision_scores"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "diagram_layouts_diagram_node_uq" ON "diagram_layouts" USING btree ("diagram_id","node_id") WHERE "diagram_layouts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "edges_pred_succ_uq" ON "edges" USING btree ("predecessor_id","successor_id") WHERE "edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "habit_completions_habit_occurrence_uq" ON "habit_completions" USING btree ("habit_id","occurrence_date") WHERE "habit_completions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_memberships_sprint_node_uq" ON "sprint_memberships" USING btree ("sprint_id","node_id") WHERE "sprint_memberships"."deleted_at" IS NULL;
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "automation_trigger_check" CHECK ("automation_rules"."trigger" IN ('task_completed','task_created'))
);
--> statement-breakpoint
CREATE TABLE "blocker_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"scope" jsonb NOT NULL,
	"predicate" jsonb NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"device_id" text NOT NULL,
	"hlc" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"reject_reason" text,
	CONSTRAINT "command_log_result_check" CHECK ("command_log"."result" IN ('applied','rejected','noop'))
);
--> statement-breakpoint
CREATE TABLE "computed_aggregates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"subject_kind" text NOT NULL,
	"subject_id" uuid,
	"metric" text NOT NULL,
	"value" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"computed_by" text NOT NULL,
	CONSTRAINT "computed_aggregates_subject_metric_uq" UNIQUE NULLS NOT DISTINCT("user_id","subject_kind","subject_id","metric"),
	CONSTRAINT "aggregates_subject_kind_check" CHECK ("computed_aggregates"."subject_kind" IN ('habit','node','user')),
	CONSTRAINT "aggregates_computed_by_check" CHECK ("computed_aggregates"."computed_by" IN ('client','server'))
);
--> statement-breakpoint
CREATE TABLE "decision_boards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"board_id" uuid NOT NULL,
	"label" text NOT NULL,
	"weight" real NOT NULL,
	CONSTRAINT "criteria_weight_check" CHECK ("decision_criteria"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "decision_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"criterion_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"score" real NOT NULL,
	CONSTRAINT "decision_scores_criterion_project_uq" UNIQUE("criterion_id","project_id"),
	CONSTRAINT "scores_score_check" CHECK ("decision_scores"."score" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "diagram_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"diagram_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "diagram_layouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"diagram_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"group_id" uuid,
	"collapsed" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone,
	CONSTRAINT "diagram_layouts_diagram_node_uq" UNIQUE("diagram_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"edge_type" text DEFAULT 'FS' NOT NULL,
	"lag_minutes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "edges_pred_succ_uq" UNIQUE("predecessor_id","successor_id"),
	CONSTRAINT "edges_edge_type_check" CHECK ("edges"."edge_type" IN ('FS','SS','FF','SF'))
);
--> statement-breakpoint
CREATE TABLE "external_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_facts_user_kind_key_uq" UNIQUE("user_id","kind","key")
);
--> statement-breakpoint
CREATE TABLE "habit_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"habit_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "habit_completions_habit_occurrence_uq" UNIQUE("habit_id","occurrence_date")
);
--> statement-breakpoint
CREATE TABLE "habits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"vision_id" uuid NOT NULL,
	"title" text NOT NULL,
	"rrule" text NOT NULL,
	"streak_mode" text NOT NULL,
	"daily_target_minutes" integer,
	"mastery_target_hours" integer,
	"level_thresholds_hours" integer[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "habits_streak_mode_check" CHECK ("habits"."streak_mode" IN ('perfect_planned','daily','weekly','monthly','quarterly','yearly'))
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"parent_id" uuid,
	"node_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" text NOT NULL,
	"start_date" date,
	"due_date" date,
	"estimate_minutes" integer,
	"completed_at" timestamp with time zone,
	"habit_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "nodes_node_type_check" CHECK ("nodes"."node_type" IN ('vision','roadmap','project','milestone','task','activity'))
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"anchor_type" text DEFAULT 'none' NOT NULL,
	"rrule" text,
	"status" text DEFAULT 'committed' NOT NULL,
	"suggestion_reason" text,
	"computed_at" timestamp with time zone,
	"external_event_id" text,
	CONSTRAINT "blocks_anchor_type_check" CHECK ("schedule_blocks"."anchor_type" IN ('none','start','end','both')),
	CONSTRAINT "blocks_status_check" CHECK ("schedule_blocks"."status" IN ('committed','suggested')),
	CONSTRAINT "blocks_interval_check" CHECK ("schedule_blocks"."ends_at" > "schedule_blocks"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "sprint_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"sprint_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	CONSTRAINT "sprint_memberships_sprint_node_uq" UNIQUE("sprint_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"title" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"focus_factor" real,
	"completed_session" boolean,
	"planned" boolean DEFAULT true NOT NULL,
	"device_id" text NOT NULL,
	CONSTRAINT "entries_focus_factor_check" CHECK ("time_entries"."focus_factor" BETWEEN 0.5 AND 1.0),
	CONSTRAINT "entries_interval_check" CHECK ("time_entries"."ended_at" IS NULL OR "time_entries"."ended_at" > "time_entries"."started_at")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"day_reset_hour" smallint DEFAULT 4 NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"weather_location" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_day_reset_hour_check" CHECK ("user_settings"."day_reset_hour" BETWEEN 0 AND 23)
);
--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD CONSTRAINT "decision_criteria_board_id_decision_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."decision_boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD CONSTRAINT "decision_scores_criterion_id_decision_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."decision_criteria"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_scores" ADD CONSTRAINT "decision_scores_project_id_nodes_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagram_layouts" ADD CONSTRAINT "diagram_layouts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_predecessor_id_nodes_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_successor_id_nodes_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_completions" ADD CONSTRAINT "habit_completions_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_vision_id_nodes_id_fk" FOREIGN KEY ("vision_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_task_id_nodes_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD CONSTRAINT "sprint_memberships_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_memberships" ADD CONSTRAINT "sprint_memberships_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_nodes_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_succ" ON "edges" USING btree ("user_id","successor_id") WHERE "edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "edges_pred" ON "edges" USING btree ("user_id","predecessor_id") WHERE "edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_children" ON "nodes" USING btree ("user_id","parent_id","sort_order") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_by_type" ON "nodes" USING btree ("user_id","node_type") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_due" ON "nodes" USING btree ("user_id","due_date") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "blocks_time" ON "schedule_blocks" USING btree ("user_id","starts_at") WHERE "schedule_blocks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "blocks_task" ON "schedule_blocks" USING btree ("user_id","task_id") WHERE "schedule_blocks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_open" ON "time_entries" USING btree ("user_id") WHERE "time_entries"."ended_at" IS NULL AND "time_entries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "entries_task" ON "time_entries" USING btree ("user_id","task_id","started_at") WHERE "time_entries"."deleted_at" IS NULL;
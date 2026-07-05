CREATE TABLE "task_steps" (
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
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"sort_order" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_nodes_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_steps_task_idx" ON "task_steps" USING btree ("user_id","task_id") WHERE "task_steps"."deleted_at" IS NULL;--> statement-breakpoint
-- R10/S6-F4: the `powersync` publication is SCOPED (migration 0009), so a newly
-- synced table must be added explicitly or PowerSync silently delivers nothing.
-- Runs after 0009 in every era (fresh DB, a converted FOR ALL TABLES publication,
-- or a plain test DB). After upgrading a LIVE deployment, restart the PowerSync
-- container so it reprocesses (docs/SELF_HOSTING.md "Upgrade notes").
ALTER PUBLICATION powersync ADD TABLE task_steps;
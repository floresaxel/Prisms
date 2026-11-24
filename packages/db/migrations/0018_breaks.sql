CREATE TABLE "breaks" (
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
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"planned_minutes" smallint NOT NULL,
	CONSTRAINT "breaks_interval_check" CHECK ("breaks"."ended_at" >= "breaks"."started_at"),
	CONSTRAINT "breaks_planned_minutes_check" CHECK ("breaks"."planned_minutes" BETWEEN 1 AND 240)
);
--> statement-breakpoint
CREATE INDEX "breaks_user_started_idx" ON "breaks" USING btree ("user_id","started_at") WHERE "breaks"."deleted_at" IS NULL;--> statement-breakpoint
-- R10/S6-F4: the `powersync` publication is SCOPED (migration 0009), so a newly
-- synced table must be added explicitly or PowerSync silently delivers nothing.
-- After upgrading a LIVE deployment, restart the PowerSync container so it
-- reprocesses (docs/SELF_HOSTING.md "Upgrade notes").
ALTER PUBLICATION powersync ADD TABLE breaks;

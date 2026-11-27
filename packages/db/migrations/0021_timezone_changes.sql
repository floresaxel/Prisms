CREATE TABLE "timezone_changes" (
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
	"changed_at" timestamp with time zone NOT NULL,
	"from_timezone" text NOT NULL,
	"to_timezone" text NOT NULL,
	"cause" text NOT NULL,
	CONSTRAINT "timezone_changes_cause_check" CHECK ("timezone_changes"."cause" IN ('device', 'manual'))
);
--> statement-breakpoint
CREATE INDEX "timezone_changes_user_changed_idx" ON "timezone_changes" USING btree ("user_id","changed_at") WHERE "timezone_changes"."deleted_at" IS NULL;--> statement-breakpoint
-- R10/S6-F4: the `powersync` publication is SCOPED (migration 0009), so a newly
-- synced table must be added explicitly or PowerSync silently delivers nothing.
-- After upgrading a LIVE deployment, restart the PowerSync container so it
-- reprocesses (docs/SELF_HOSTING.md "Upgrade notes").
ALTER PUBLICATION powersync ADD TABLE timezone_changes;

CREATE TABLE "journal_entries" (
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
	"entry_date" date NOT NULL,
	"month_key" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	CONSTRAINT "journal_entries_month_key_check" CHECK ("journal_entries"."month_key" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_user_date_uq" ON "journal_entries" USING btree ("user_id","entry_date") WHERE "journal_entries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_month" ON "journal_entries" USING btree ("user_id","month_key") WHERE "journal_entries"."deleted_at" IS NULL;--> statement-breakpoint
-- R10/S6-F4: the `powersync` publication is SCOPED (migration 0009), so a newly
-- synced table must be added explicitly or PowerSync silently delivers nothing.
-- Runs after 0009 in every era — fresh DB, a converted FOR ALL TABLES publication,
-- or a plain test DB (0009 guarantees a scoped publication named `powersync`
-- exists by now). After upgrading a LIVE deployment, restart the PowerSync
-- container so it reprocesses (docs/SELF_HOSTING.md "Upgrade notes").
ALTER PUBLICATION powersync ADD TABLE journal_entries;
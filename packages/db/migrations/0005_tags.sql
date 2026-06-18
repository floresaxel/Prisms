CREATE TABLE "tag_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"placement_id" uuid NOT NULL,
	"value" text NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tag_answers_value_check" CHECK ("tag_answers"."value" IN ('yes','no'))
);
--> statement-breakpoint
CREATE TABLE "tag_placements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"block_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"label" text NOT NULL,
	"habit_id" uuid
);
--> statement-breakpoint
ALTER TABLE "tag_answers" ADD CONSTRAINT "tag_answers_placement_id_tag_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."tag_placements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD CONSTRAINT "tag_placements_block_id_schedule_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."schedule_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_placements" ADD CONSTRAINT "tag_placements_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tag_answers_placement_uq" ON "tag_answers" USING btree ("placement_id") WHERE "tag_answers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tag_placements_block_tag_uq" ON "tag_placements" USING btree ("block_id","tag_id") WHERE "tag_placements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tag_placements_block" ON "tag_placements" USING btree ("user_id","block_id") WHERE "tag_placements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tag_placements_tag" ON "tag_placements" USING btree ("user_id","tag_id") WHERE "tag_placements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_label_uq" ON "tags" USING btree ("user_id","label") WHERE "tags"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tags_habit" ON "tags" USING btree ("user_id","habit_id") WHERE "tags"."deleted_at" IS NULL;
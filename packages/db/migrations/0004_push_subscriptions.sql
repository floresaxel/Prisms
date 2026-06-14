CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_uq" UNIQUE("user_id","endpoint"),
	CONSTRAINT "push_subscriptions_kind_check" CHECK ("push_subscriptions"."kind" IN ('web','expo'))
);

CREATE TABLE "command_field_versions" (
	"user_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"field" text NOT NULL,
	"hlc" text NOT NULL,
	CONSTRAINT "command_field_versions_table_name_row_id_field_pk" PRIMARY KEY("table_name","row_id","field")
);

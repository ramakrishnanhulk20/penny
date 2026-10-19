CREATE TABLE "checks_snapshot" (
	"id" smallint PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "checks_snapshot_single_row" CHECK ("checks_snapshot"."id" = 1)
);

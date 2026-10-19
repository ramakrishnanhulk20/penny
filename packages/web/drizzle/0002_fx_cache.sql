CREATE TABLE "fx_cache" (
	"pair" char(7) PRIMARY KEY NOT NULL,
	"rate" text NOT NULL,
	"rate_date" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_pk" PRIMARY KEY("bucket","key","window_start")
);

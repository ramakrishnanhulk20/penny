CREATE TABLE "events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_parts" (
	"expense_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"weight" bigint NOT NULL,
	CONSTRAINT "expense_parts_pk" PRIMARY KEY("expense_id","member_id"),
	CONSTRAINT "expense_parts_weight_positive" CHECK ("expense_parts"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"description" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"rate_units" bigint,
	"rate_scale" smallint,
	"paid_by" uuid NOT NULL,
	"split_mode" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_group_id_client_id_unique" UNIQUE("group_id","client_id"),
	CONSTRAINT "expenses_group_id_id_unique" UNIQUE("group_id","id"),
	CONSTRAINT "expenses_amount_minor_positive" CHECK ("expenses"."amount_minor" > 0),
	CONSTRAINT "expenses_rate_pair" CHECK (("expenses"."rate_units" is null) = ("expenses"."rate_scale" is null)),
	CONSTRAINT "expenses_split_mode_known" CHECK ("expenses"."split_mode" in ('equal', 'shares', 'exact'))
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"base_currency" char(3) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"position" smallint NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_group_id_id_unique" UNIQUE("group_id","id"),
	CONSTRAINT "members_group_id_position_unique" UNIQUE("group_id","position")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"from_member" uuid NOT NULL,
	"to_member" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"rate_units" bigint,
	"rate_scale" smallint,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_group_id_client_id_unique" UNIQUE("group_id","client_id"),
	CONSTRAINT "payments_amount_minor_positive" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_rate_pair" CHECK (("payments"."rate_units" is null) = ("payments"."rate_scale" is null)),
	CONSTRAINT "payments_distinct_members" CHECK ("payments"."from_member" <> "payments"."to_member")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_expense_fk" FOREIGN KEY ("group_id","expense_id") REFERENCES "public"."expenses"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_member_fk" FOREIGN KEY ("group_id","member_id") REFERENCES "public"."members"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_member_fk" FOREIGN KEY ("group_id","paid_by") REFERENCES "public"."members"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_from_member_fk" FOREIGN KEY ("group_id","from_member") REFERENCES "public"."members"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_to_member_fk" FOREIGN KEY ("group_id","to_member") REFERENCES "public"."members"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_live_name_key_unique" ON "members" USING btree ("group_id","name_key") WHERE "members"."removed_at" is null;
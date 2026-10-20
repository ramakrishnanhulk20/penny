ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_weight_max" CHECK ("expense_parts"."weight" <= 1000000000000);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_minor_max" CHECK ("expenses"."amount_minor" <= 1000000000000);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_currency_format" CHECK ("expenses"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_rate_units_positive" CHECK ("expenses"."rate_units" > 0);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_rate_scale_range" CHECK ("expenses"."rate_scale" between 0 and 10);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_version_nonnegative" CHECK ("expenses"."version" >= 0);--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_base_currency_format" CHECK ("groups"."base_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_version_nonnegative" CHECK ("groups"."version" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_minor_max" CHECK ("payments"."amount_minor" <= 1000000000000);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_format" CHECK ("payments"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_rate_units_positive" CHECK ("payments"."rate_units" > 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_rate_scale_range" CHECK ("payments"."rate_scale" between 0 and 10);
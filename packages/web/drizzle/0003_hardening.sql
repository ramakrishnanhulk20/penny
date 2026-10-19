CREATE TABLE "server_keys" (
	"id" smallint PRIMARY KEY NOT NULL,
	"hmac_key" "bytea" NOT NULL,
	CONSTRAINT "server_keys_single_row" CHECK ("server_keys"."id" = 1)
);
--> statement-breakpoint
-- Written by hand from here on and kept out of schema.ts: drizzle-kit cannot express triggers, and it builds each new
-- migration from its own snapshots, so later generated migrations leave these objects alone.
ALTER TABLE groups ADD CONSTRAINT groups_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE INDEX events_group_seq ON events (group_id, seq);
--> statement-breakpoint
CREATE INDEX events_group_entity ON events (group_id, entity_id);
--> statement-breakpoint
-- The event log is the record balances are rebuilt from, so no statement may change or remove a row once written,
-- even one sent by a bug. Groups are never deleted by the app, so the ON DELETE CASCADE from groups to events never
-- fires in practice; if a group with events were ever deleted, this trigger would refuse it.
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events are append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
--> statement-breakpoint
-- Rows written before this migration hold raw client addresses as keys; from now on every key is an HMAC.
DELETE FROM rate_limits;

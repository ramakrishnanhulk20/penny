import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  customType,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// The bounds the app already enforces, repeated here as database checks so no write from any path can store a value
// the app would refuse. A currency code is three ASCII capitals (core's currency()); an amount is at most
// MAX_AMOUNT_MINOR, 10^12 minor units (core's parseAmount); a rate has a positive units and a scale of at most
// MAX_RATE_SCALE, 10 (core's parseRate). test/schema.test.ts holds each bound to core's own constant.
const CURRENCY_CODE = sql.raw("'^[A-Z]{3}$'");
const MAX_AMOUNT_MINOR = sql.raw("1000000000000");
const MAX_RATE_SCALE = sql.raw("10");

// drizzle-orm 0.45 has no bytea column of its own.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Only the sha256 of the link token is stored, so a copy of the database holds no working link. The constraint
    // groups_token_hash_format (64 lowercase hex characters) is hand-written in migration 0003, outside this file.
    tokenHash: text("token_hash").notNull().unique("groups_token_hash_unique"),
    name: text("name").notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("groups_base_currency_format", sql`${t.baseCurrency} ~ ${CURRENCY_CODE}`),
    check("groups_version_nonnegative", sql`${t.version} >= 0`),
  ],
);

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    position: smallint("position").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of every (group_id, member) foreign key below: a row can only name a member of its own group.
    unique("members_group_id_id_unique").on(t.groupId, t.id),
    unique("members_group_id_position_unique").on(t.groupId, t.position),
    // Removed members keep their history, so only live members compete for a name.
    uniqueIndex("members_live_name_key_unique")
      .on(t.groupId, t.nameKey)
      .where(sql`${t.removedAt} is null`),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    requestHash: text("request_hash").notNull(),
    description: text("description").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    rateUnits: bigint("rate_units", { mode: "bigint" }),
    rateScale: smallint("rate_scale"),
    paidBy: uuid("paid_by").notNull(),
    splitMode: text("split_mode").notNull(),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("expenses_amount_minor_positive", sql`${t.amountMinor} > 0`),
    check("expenses_amount_minor_max", sql`${t.amountMinor} <= ${MAX_AMOUNT_MINOR}`),
    check("expenses_currency_format", sql`${t.currency} ~ ${CURRENCY_CODE}`),
    check("expenses_rate_pair", sql`(${t.rateUnits} is null) = (${t.rateScale} is null)`),
    check("expenses_rate_units_positive", sql`${t.rateUnits} > 0`),
    check("expenses_rate_scale_range", sql`${t.rateScale} between 0 and ${MAX_RATE_SCALE}`),
    check("expenses_split_mode_known", sql`${t.splitMode} in ('equal', 'shares', 'exact')`),
    check("expenses_version_nonnegative", sql`${t.version} >= 0`),
    // A retried create finds its first row here instead of writing a second one.
    unique("expenses_group_id_client_id_unique").on(t.groupId, t.clientId),
    unique("expenses_group_id_id_unique").on(t.groupId, t.id),
    foreignKey({
      name: "expenses_paid_by_member_fk",
      columns: [t.groupId, t.paidBy],
      foreignColumns: [members.groupId, members.id],
    }),
  ],
);

export const expenseParts = pgTable(
  "expense_parts",
  {
    expenseId: uuid("expense_id").notNull(),
    groupId: uuid("group_id").notNull(),
    memberId: uuid("member_id").notNull(),
    weight: bigint("weight", { mode: "bigint" }).notNull(),
  },
  (t) => [
    check("expense_parts_weight_positive", sql`${t.weight} > 0`),
    // An exact split stores each part's minor units here, so the amount bound holds; shares and equal weights sit far
    // below it.
    check("expense_parts_weight_max", sql`${t.weight} <= ${MAX_AMOUNT_MINOR}`),
    primaryKey({ name: "expense_parts_pk", columns: [t.expenseId, t.memberId] }),
    foreignKey({
      name: "expense_parts_expense_fk",
      columns: [t.groupId, t.expenseId],
      foreignColumns: [expenses.groupId, expenses.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "expense_parts_member_fk",
      columns: [t.groupId, t.memberId],
      foreignColumns: [members.groupId, members.id],
    }),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    requestHash: text("request_hash").notNull(),
    fromMember: uuid("from_member").notNull(),
    toMember: uuid("to_member").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    rateUnits: bigint("rate_units", { mode: "bigint" }),
    rateScale: smallint("rate_scale"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payments_amount_minor_positive", sql`${t.amountMinor} > 0`),
    check("payments_amount_minor_max", sql`${t.amountMinor} <= ${MAX_AMOUNT_MINOR}`),
    check("payments_currency_format", sql`${t.currency} ~ ${CURRENCY_CODE}`),
    check("payments_rate_pair", sql`(${t.rateUnits} is null) = (${t.rateScale} is null)`),
    check("payments_rate_units_positive", sql`${t.rateUnits} > 0`),
    check("payments_rate_scale_range", sql`${t.rateScale} between 0 and ${MAX_RATE_SCALE}`),
    check("payments_distinct_members", sql`${t.fromMember} <> ${t.toMember}`),
    unique("payments_group_id_client_id_unique").on(t.groupId, t.clientId),
    foreignKey({
      name: "payments_from_member_fk",
      columns: [t.groupId, t.fromMember],
      foreignColumns: [members.groupId, members.id],
    }),
    foreignKey({
      name: "payments_to_member_fk",
      columns: [t.groupId, t.toMember],
      foreignColumns: [members.groupId, members.id],
    }),
  ],
);

// Append-only: triggers hand-written in migration 0003, outside this file, refuse every UPDATE, DELETE and TRUNCATE.
export const events = pgTable("events", {
  // Event order is this database sequence, never a clock: two servers can disagree on the time.
  seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  entityId: uuid("entity_id"),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row shared by every server instance, so /checks costs GitHub one bounded refresh per window however many
// instances run (threat model C21).
export const checksSnapshot = pgTable(
  "checks_snapshot",
  {
    id: smallint("id").primaryKey(),
    payload: jsonb("payload").notNull(),
    // When the row was last refreshed or last tried, which paces the next try. The time of the last good read from
    // GitHub sits inside the payload, so a failed try can wait out its window without changing that time.
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("checks_snapshot_single_row", sql`${t.id} = 1`)],
);

// Shared by every instance, so frankfurter is asked about a pair at most once per 12 hours however many instances
// run (threat model C19). The rate is kept as the decimal text parseRate accepted, never as a float.
export const fxCache = pgTable("fx_cache", {
  pair: char("pair", { length: 7 }).primaryKey(),
  rate: text("rate").notNull(),
  rateDate: date("rate_date", { mode: "string" }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

// One fixed-window counter per bucket, key and window. A row in Postgres rather than memory, so the limit holds across
// every serverless instance (threat model C26). The key is a group id or an HMAC of the client network, never an
// address.
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ name: "rate_limits_pk", columns: [t.bucket, t.key, t.windowStart] })],
);

// The secret the rate limiter hashes client networks with. One row, made with 32 random bytes by the first instance
// that needs it, so no address in rate_limits can be read back without it.
export const serverKeys = pgTable(
  "server_keys",
  {
    id: smallint("id").primaryKey(),
    hmacKey: bytea("hmac_key").notNull(),
  },
  (t) => [check("server_keys_single_row", sql`${t.id} = 1`)],
);

export type GroupRow = typeof groups.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type ExpenseRow = typeof expenses.$inferSelect;
export type ExpensePartRow = typeof expenseParts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type EventRow = typeof events.$inferSelect;

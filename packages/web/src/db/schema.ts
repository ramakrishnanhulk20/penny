import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
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

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Only the sha256 of the link token is stored, so a copy of the database holds no working link.
  tokenHash: text("token_hash").notNull().unique("groups_token_hash_unique"),
  name: text("name").notNull(),
  baseCurrency: char("base_currency", { length: 3 }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    check("expenses_rate_pair", sql`(${t.rateUnits} is null) = (${t.rateScale} is null)`),
    check("expenses_split_mode_known", sql`${t.splitMode} in ('equal', 'shares', 'exact')`),
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
    check("payments_rate_pair", sql`(${t.rateUnits} is null) = (${t.rateScale} is null)`),
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

export type GroupRow = typeof groups.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type ExpenseRow = typeof expenses.$inferSelect;
export type ExpensePartRow = typeof expenseParts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type EventRow = typeof events.$inferSelect;

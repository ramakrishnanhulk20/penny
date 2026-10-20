// Not covered: the application checks in front of these constraints (amount parsing, split rules, comparing request_hash on a retry),
// or Neon itself: this runs on PGlite, Postgres compiled to WebAssembly. Existing rows on Neon are checked when the
// migration adds each constraint; that run is not part of this file.
import { MAX_AMOUNT_MINOR, MAX_RATE_SCALE } from "@penny/core";
import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, expenseParts, expenses, groups, members, payments } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { mintGroupToken } from "@/lib/group-token";

type Refusal = { code?: string; constraint?: string };

// Drizzle wraps the driver error; the Postgres code and constraint name sit on its cause.
async function refusal(query: PromiseLike<unknown>): Promise<Refusal> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    return cause as Refusal;
  }
  throw new Error("expected the database to refuse this write");
}

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function makeGroup(memberNames: string[]) {
  const [group] = await db
    .insert(groups)
    .values({ tokenHash: mintGroupToken().hash, name: "Flat 4B", baseCurrency: "EUR" })
    .returning();
  const people = await db
    .insert(members)
    .values(memberNames.map((name, position) => ({ groupId: group.id, name, nameKey: name.toLowerCase(), position })))
    .returning();
  return { group, people };
}

function expenseValues(groupId: string, paidBy: string, clientId = crypto.randomUUID()) {
  return {
    groupId,
    clientId,
    requestHash: "a".repeat(64),
    description: "Groceries",
    currency: "EUR",
    amountMinor: BigInt(4200),
    paidBy,
    splitMode: "equal",
  };
}

function paymentValues(groupId: string, fromMember: string, toMember: string) {
  return {
    groupId,
    clientId: crypto.randomUUID(),
    requestHash: "b".repeat(64),
    fromMember,
    toMember,
    currency: "EUR",
    amountMinor: BigInt(1500),
  };
}

describe("database constraints", () => {
  it("refuses a second expense with the same client id in one group, but allows it in another", async () => {
    const a = await makeGroup(["Asha", "Ben"]);
    const b = await makeGroup(["Chen"]);
    await db.insert(expenses).values(expenseValues(a.group.id, a.people[0].id, "retry-1"));

    expect(await refusal(db.insert(expenses).values(expenseValues(a.group.id, a.people[1].id, "retry-1")))).toMatchObject({
      code: "23505",
      constraint: "expenses_group_id_client_id_unique",
    });
    await db.insert(expenses).values(expenseValues(b.group.id, b.people[0].id, "retry-1"));
    const rows = await db.select().from(expenses).where(eq(expenses.clientId, "retry-1"));
    expect(rows).toHaveLength(2);
  });

  it("refuses an expense paid by a member of another group", async () => {
    const a = await makeGroup(["Asha"]);
    const b = await makeGroup(["Chen"]);

    expect(await refusal(db.insert(expenses).values(expenseValues(a.group.id, b.people[0].id)))).toMatchObject({
      code: "23503",
      constraint: "expenses_paid_by_member_fk",
    });
  });

  it("refuses an expense part that names a member of another group", async () => {
    const a = await makeGroup(["Asha"]);
    const b = await makeGroup(["Chen"]);
    const [expense] = await db.insert(expenses).values(expenseValues(a.group.id, a.people[0].id)).returning();

    const part = { expenseId: expense.id, groupId: a.group.id, memberId: b.people[0].id, weight: BigInt(1) };
    expect(await refusal(db.insert(expenseParts).values(part))).toMatchObject({
      code: "23503",
      constraint: "expense_parts_member_fk",
    });
    const relabelled = { ...part, groupId: b.group.id };
    expect(await refusal(db.insert(expenseParts).values(relabelled))).toMatchObject({
      code: "23503",
      constraint: "expense_parts_expense_fk",
    });
  });

  it("refuses a payment from a member to themselves", async () => {
    const { group, people } = await makeGroup(["Asha"]);

    expect(await refusal(db.insert(payments).values(paymentValues(group.id, people[0].id, people[0].id)))).toMatchObject({
      code: "23514",
      constraint: "payments_distinct_members",
    });
  });

  it("refuses an amount of zero on expenses and payments", async () => {
    const { group, people } = await makeGroup(["Asha", "Ben"]);

    expect(
      await refusal(db.insert(expenses).values({ ...expenseValues(group.id, people[0].id), amountMinor: BigInt(0) })),
    ).toMatchObject({ code: "23514", constraint: "expenses_amount_minor_positive" });
    expect(
      await refusal(db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), amountMinor: BigInt(0) })),
    ).toMatchObject({ code: "23514", constraint: "payments_amount_minor_positive" });
  });

  it("refuses a rate with units but no scale, or a scale but no units", async () => {
    const { group, people } = await makeGroup(["Asha", "Ben"]);
    const base = expenseValues(group.id, people[0].id);

    expect(await refusal(db.insert(expenses).values({ ...base, rateUnits: BigInt(108250) }))).toMatchObject({
      code: "23514",
      constraint: "expenses_rate_pair",
    });
    expect(await refusal(db.insert(expenses).values({ ...base, rateScale: 5 }))).toMatchObject({
      code: "23514",
      constraint: "expenses_rate_pair",
    });
    expect(
      await refusal(
        db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), rateUnits: BigInt(108250) }),
      ),
    ).toMatchObject({ code: "23514", constraint: "payments_rate_pair" });
    await db.insert(expenses).values({ ...base, rateUnits: BigInt(108250), rateScale: 5 });
  });

  it("refuses two live members with one name key, while a removed one does not block", async () => {
    const { group, people } = await makeGroup(["Asha"]);
    const duplicate = { groupId: group.id, name: "ASHA", nameKey: "asha", position: 1 };

    expect(await refusal(db.insert(members).values(duplicate))).toMatchObject({
      code: "23505",
      constraint: "members_live_name_key_unique",
    });
    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, people[0].id));
    const [rejoined] = await db.insert(members).values(duplicate).returning();
    expect(rejoined.nameKey).toBe("asha");
  });

  it("returns events in database sequence order and refuses a caller-chosen sequence number", async () => {
    const { group } = await makeGroup(["Asha"]);
    const kinds = ["group.created", "expense.added", "payment.added", "expense.deleted"];
    for (const kind of kinds) {
      await db.insert(events).values({ groupId: group.id, kind, payload: { kind } });
    }

    const rows = await db.select().from(events).where(eq(events.groupId, group.id)).orderBy(asc(events.seq));
    expect(rows.map((row) => row.kind)).toEqual(kinds);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].seq > rows[i - 1].seq).toBe(true);
    }

    const forged = sql`insert into events (seq, group_id, kind, payload) values (1, ${group.id}, 'forged', '{}'::jsonb)`;
    expect(await refusal(db.execute(forged))).toMatchObject({ code: "428C9" });
  });

  it("holds every amount, expense or payment or exact part, to core's MAX_AMOUNT_MINOR, and takes exactly it", async () => {
    const { group, people } = await makeGroup(["Asha", "Ben"]);
    const over = MAX_AMOUNT_MINOR + BigInt(1);

    expect(
      await refusal(db.insert(expenses).values({ ...expenseValues(group.id, people[0].id), amountMinor: over })),
    ).toMatchObject({ code: "23514", constraint: "expenses_amount_minor_max" });
    expect(
      await refusal(db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), amountMinor: over })),
    ).toMatchObject({ code: "23514", constraint: "payments_amount_minor_max" });
    const [expense] = await db
      .insert(expenses)
      .values({ ...expenseValues(group.id, people[0].id), amountMinor: MAX_AMOUNT_MINOR })
      .returning();
    const part = { expenseId: expense.id, groupId: group.id, memberId: people[1].id };
    expect(await refusal(db.insert(expenseParts).values({ ...part, weight: over }))).toMatchObject({
      code: "23514",
      constraint: "expense_parts_weight_max",
    });
    await db.insert(expenseParts).values({ ...part, weight: MAX_AMOUNT_MINOR });
    await db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), amountMinor: MAX_AMOUNT_MINOR });
  });

  it.each(["eur", "EU", "xx?", "E1R", "ÉUR"])("refuses the currency code %j on groups, expenses and payments", async (code) => {
    const { group, people } = await makeGroup(["Asha", "Ben"]);

    expect(await refusal(db.update(groups).set({ baseCurrency: code }).where(eq(groups.id, group.id)))).toMatchObject({
      code: "23514",
      constraint: "groups_base_currency_format",
    });
    expect(
      await refusal(db.insert(expenses).values({ ...expenseValues(group.id, people[0].id), currency: code })),
    ).toMatchObject({ code: "23514", constraint: "expenses_currency_format" });
    expect(
      await refusal(db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), currency: code })),
    ).toMatchObject({ code: "23514", constraint: "payments_currency_format" });
  });

  it("refuses rate units of zero or less and a scale outside 0 to core's MAX_RATE_SCALE, and takes both ends", async () => {
    const { group, people } = await makeGroup(["Asha", "Ben"]);
    const expense = (rateUnits: bigint, rateScale: number) =>
      db.insert(expenses).values({ ...expenseValues(group.id, people[0].id), currency: "USD", rateUnits, rateScale });
    const payment = (rateUnits: bigint, rateScale: number) =>
      db.insert(payments).values({ ...paymentValues(group.id, people[0].id, people[1].id), currency: "USD", rateUnits, rateScale });

    for (const [table, write] of [
      ["expenses", expense],
      ["payments", payment],
    ] as const) {
      expect(await refusal(write(BigInt(0), 2))).toMatchObject({ constraint: `${table}_rate_units_positive` });
      expect(await refusal(write(BigInt(-5), 2))).toMatchObject({ constraint: `${table}_rate_units_positive` });
      expect(await refusal(write(BigInt(92), -1))).toMatchObject({ constraint: `${table}_rate_scale_range` });
      expect(await refusal(write(BigInt(92), MAX_RATE_SCALE + 1))).toMatchObject({ constraint: `${table}_rate_scale_range` });
      await write(BigInt(1), 0);
      await write(BigInt(1), MAX_RATE_SCALE);
    }
  });

  it("refuses a negative version on groups and expenses, and takes 0", async () => {
    const { group, people } = await makeGroup(["Asha"]);
    const [expense] = await db.insert(expenses).values(expenseValues(group.id, people[0].id)).returning();

    expect(await refusal(db.update(groups).set({ version: -1 }).where(eq(groups.id, group.id)))).toMatchObject({
      code: "23514",
      constraint: "groups_version_nonnegative",
    });
    expect(await refusal(db.update(expenses).set({ version: -1 }).where(eq(expenses.id, expense.id)))).toMatchObject({
      code: "23514",
      constraint: "expenses_version_nonnegative",
    });
    await db.update(groups).set({ version: 0 }).where(eq(groups.id, group.id));
    await db.update(expenses).set({ version: 0 }).where(eq(expenses.id, expense.id));
  });
});

// Not covered: editing, deleting and payments (not built yet), rate limits, a removed member in a split, the
// reference-rate lookup, or the Neon driver (this runs on in-memory PGlite, where transactions never truly overlap).
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, expenses } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { AddExpenseRequest, AddExpenseResponse, CreateGroupResponse, GroupView } from "@/lib/api-types";
import { mintGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { addExpense, MAX_LIVE_EXPENSES } from "@/lib/ledger-store";
import { errorCode, expenseBody, postExpense, readGroup, startGroup, toMinor } from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

async function expenseRows(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(expenses);
  return row.n;
}

async function added(token: string, body: AddExpenseRequest, status = 201): Promise<AddExpenseResponse> {
  const response = await postExpense(token, body);
  expect(response.status).toBe(status);
  return (await response.json()) as AddExpenseResponse;
}

function ids(group: GroupView): string[] {
  return group.members.map((member) => member.id);
}

function sumOf(amounts: string[]): bigint {
  return amounts.reduce((sum, amount) => sum + toMinor(amount), BigInt(0));
}

describe("split modes", () => {
  let token: string;
  let group: GroupView;
  let ana: string;
  let ben: string;
  let chen: string;

  beforeAll(async () => {
    ({ token, group } = await startGroup());
    [ana, ben, chen] = ids(group);
  });

  it("splits 100.00 equally three ways as 33.34, 33.33, 33.33 with balances that sum to zero", async () => {
    // Listed in reverse: the leftover cent still goes to the first member in group order.
    const body = expenseBody(group, { split: { mode: "equal", members: [chen, ben, ana] } });

    const { expense, group: after } = await added(token, body);

    expect(expense).toMatchObject({ amount: "100.00", baseAmount: "100.00", rate: null, splitMode: "equal", paidBy: ana });
    expect(expense.parts).toEqual([
      { memberId: ana, amount: "33.34", baseAmount: "33.34" },
      { memberId: ben, amount: "33.33", baseAmount: "33.33" },
      { memberId: chen, amount: "33.33", baseAmount: "33.33" },
    ]);
    expect(after.balances.map((row) => row.amount)).toEqual(["66.66", "-33.33", "-33.33"]);
    expect(sumOf(after.balances.map((row) => row.amount))).toBe(BigInt(0));
    expect(after.total).toBe("0.00");
    expect(await readGroup(token)).toEqual(after);
  });

  it("splits by shares with the leftover cent to the largest remainder", async () => {
    const body = expenseBody(group, {
      amount: "10.00",
      paidBy: ben,
      split: {
        mode: "shares",
        parts: [
          { memberId: ben, weight: 1 },
          { memberId: ana, weight: 2 },
        ],
      },
    });

    const { expense } = await added(token, body);

    expect(expense.splitMode).toBe("shares");
    expect(expense.parts.map((part) => [part.memberId, part.amount])).toEqual([
      [ana, "6.67"],
      [ben, "3.33"],
    ]);
  });

  it("takes exact amounts that add up, and refuses ones that do not", async () => {
    const exact = (a: string, b: string) =>
      expenseBody(group, {
        amount: "50.00",
        split: {
          mode: "exact",
          parts: [
            { memberId: ana, amount: a },
            { memberId: chen, amount: b },
          ],
        },
      });

    const { expense } = await added(token, exact("20.00", "30.00"));
    expect(expense.parts.map((part) => part.amount)).toEqual(["20.00", "30.00"]);

    const before = await expenseRows();
    const short = await postExpense(token, exact("20.00", "29.99"));
    expect(short.status).toBe(400);
    expect(await errorCode(short)).toBe("split_exact_sum_mismatch");
    for (const bad of ["abc", "0.00", "12.345", "-20.00"]) {
      expect(await errorCode(await postExpense(token, exact(bad, "30.00")))).toBe("split_bad_amount");
    }
    expect(await expenseRows()).toBe(before);
  });

  const refusedSplits: [string, (first: string) => Partial<AddExpenseRequest>][] = [
    ["split_empty", () => ({ split: { mode: "equal", members: [] } })],
    ["split_duplicate_member", (first) => ({ split: { mode: "equal", members: [first, first] } })],
    ["split_bad_weight", (first) => ({ split: { mode: "shares", parts: [{ memberId: first, weight: 0 }] } })],
    ["split_bad_weight", (first) => ({ split: { mode: "shares", parts: [{ memberId: first, weight: 1.5 }] } })],
    ["split_bad_weight", (first) => ({ split: { mode: "shares", parts: [{ memberId: first, weight: 1001 }] } })],
    ["split_too_many_parts", (first) => ({ split: { mode: "equal", members: Array<string>(51).fill(first) } })],
  ];

  it.each(refusedSplits)("refuses a split with %s", async (code, overrides) => {
    const before = await expenseRows();

    const response = await postExpense(token, expenseBody(group, overrides(group.members[0].id)));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await expenseRows()).toBe(before);
  });
});

describe("foreign currency", () => {
  let token: string;
  let group: GroupView;

  beforeAll(async () => {
    ({ token, group } = await startGroup());
  });

  it("converts once at the rate, and the base parts add up to the base amount", async () => {
    const { expense } = await added(token, expenseBody(group, { currency: "USD", amount: "100.00", rate: "0.920" }));

    expect(expense).toMatchObject({ currency: "USD", amount: "100.00", rate: "0.92", baseAmount: "92.00" });
    expect(expense.parts.map((part) => part.amount)).toEqual(["33.34", "33.33", "33.33"]);
    expect(expense.parts.map((part) => part.baseAmount)).toEqual(["30.67", "30.67", "30.66"]);
    expect(sumOf(expense.parts.map((part) => part.baseAmount))).toBe(toMinor(expense.baseAmount));
  });

  it.each([
    ["rate_required", { currency: "USD", rate: null }],
    ["rate_forbidden", { currency: "EUR", rate: "1" }],
    ["rate_format", { currency: "USD", rate: "0,92" }],
    ["rate_format", { currency: "USD", rate: "1e3" }],
    ["rate_too_precise", { currency: "USD", rate: "0.12345678901" }],
    ["rate_zero", { currency: "USD", rate: "0.000" }],
    ["rate_out_of_range", { currency: "USD", rate: "1000000.1" }],
    ["converts_to_zero", { currency: "USD", amount: "0.01", rate: "0.0001" }],
    ["base_too_large", { currency: "USD", amount: "10000000000.00", rate: "2" }],
  ])("refuses with %s", async (code, overrides) => {
    const before = await expenseRows();

    const response = await postExpense(token, expenseBody(group, overrides as Partial<AddExpenseRequest>));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await expenseRows()).toBe(before);
  });
});

describe("request checks", () => {
  let token: string;
  let group: GroupView;

  beforeAll(async () => {
    ({ token, group } = await startGroup({ baseCurrency: "USD" }));
  });

  it.each([
    ["amount_format", "1e3"],
    ["amount_format", "-5"],
    ["amount_format", " 12"],
    ["amount_format", "1,5"],
    ["amount_format", ""],
    ["amount_format", "0x10"],
    ["amount_format", "NaN"],
    ["amount_format", "12."],
    ["amount_format", "012"],
    ["amount_format", "１２"],
    ["amount_too_many_decimals", "12.345"],
    ["amount_too_many_decimals", "12.500"],
    ["amount_zero", "0"],
    ["amount_zero", "0.00"],
    ["amount_too_large", "10000000000.01"],
  ])("answers %s for the USD amount %j", async (code, amount) => {
    const before = await expenseRows();

    const response = await postExpense(token, expenseBody(group, { amount }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await expenseRows()).toBe(before);
  });

  it("accepts the largest amount there is", async () => {
    const { expense } = await added(token, expenseBody(group, { amount: "10000000000.00" }));
    expect(expense.amount).toBe("10000000000.00");
  });

  it.each([
    ["bad_currency", { currency: "usd" }],
    ["bad_currency", { currency: "XXX" }],
    ["bad_description", { description: "  " }],
    ["bad_description", { description: "d".repeat(81) }],
    ["bad_description", { description: "Taxi‮" }],
    ["invalid_body", { clientId: "short" }],
    ["invalid_body", { clientId: "has space in it" }],
    ["invalid_body", { amount: 12.5 }],
    ["invalid_body", { groupId: "anything" }],
    ["invalid_body", { split: { mode: "percent", members: [] } }],
  ])("answers %s for %j", async (code, overrides) => {
    const before = await expenseRows();

    const response = await postExpense(token, { ...expenseBody(group), ...overrides });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await expenseRows()).toBe(before);
  });

  it("refuses a body without the rate field", async () => {
    const body: Partial<AddExpenseRequest> = expenseBody(group);
    delete body.rate;

    expect(await errorCode(await postExpense(token, body))).toBe("invalid_body");
  });

  it("answers an unknown token with the plain 404", async () => {
    const response = await postExpense(mintGroupToken().token, expenseBody(group));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":{"code":"not_found"}}');
  });
});

describe("one group cannot reach another", () => {
  let a: CreateGroupResponse;
  let b: CreateGroupResponse;

  beforeAll(async () => {
    a = await startGroup({ name: "Flat A" });
    b = await startGroup({ name: "Flat B" });
    await added(b.token, expenseBody(b.group, { clientId: "shared-client-id" }));
  });

  const foreignIds: [string, (mine: string, theirs: string) => Partial<AddExpenseRequest>][] = [
    ["the payer", (_mine, theirs) => ({ paidBy: theirs })],
    ["an equal split member", (mine, theirs) => ({ split: { mode: "equal", members: [mine, theirs] } })],
    ["a shares part", (_mine, theirs) => ({ split: { mode: "shares", parts: [{ memberId: theirs, weight: 1 }] } })],
    [
      "an exact part",
      (mine, theirs) => ({
        split: {
          mode: "exact",
          parts: [
            { memberId: mine, amount: "50.00" },
            { memberId: theirs, amount: "50.00" },
          ],
        },
      }),
    ],
  ];

  it.each(foreignIds)("answers 404 when %s belongs to another group, and changes neither group", async (_label, overrides) => {
    const otherBefore = await readGroup(b.token);
    const before = await expenseRows();

    const body = expenseBody(a.group, overrides(a.group.members[0].id, b.group.members[1].id));
    const response = await postExpense(a.token, body);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":{"code":"not_found"}}');
    expect(await expenseRows()).toBe(before);
    expect((await readGroup(a.token)).expenses).toEqual([]);
    expect(await readGroup(b.token)).toEqual(otherBefore);
  });

  it("treats a clientId used in another group as new, and never returns that group's expense", async () => {
    const otherExpense = (await readGroup(b.token)).expenses[0];

    const { expense } = await added(a.token, expenseBody(a.group, { clientId: "shared-client-id" }), 201);

    expect(expense.id).not.toBe(otherExpense.id);
    expect(expense.paidBy).toBe(a.group.members[0].id);
  });
});

describe("retries", () => {
  let token: string;
  let group: GroupView;

  beforeAll(async () => {
    ({ token, group } = await startGroup());
  });

  async function rowsFor(clientId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(expenses)
      .where(and(eq(expenses.groupId, group.id), eq(expenses.clientId, clientId)));
    return row.n;
  }

  it("answers a repeat with 200 and the same expense, and writes one row and one event", async () => {
    const body = expenseBody(group);

    const first = await added(token, body, 201);
    const second = await added(token, body, 200);

    expect(second.expense).toEqual(first.expense);
    expect(await rowsFor(body.clientId)).toBe(1);
    const log = await db
      .select()
      .from(events)
      .where(and(eq(events.groupId, group.id), eq(events.entityId, first.expense.id)));
    expect(log.map((row) => row.kind)).toEqual(["expense_added"]);
  });

  it("writes one row when the same request arrives twice at once", async () => {
    const body = expenseBody(group);

    const responses = await Promise.all([postExpense(token, body), postExpense(token, body)]);
    const answers = await Promise.all(responses.map(async (r) => ({ status: r.status, ...(await r.json()) })));

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(answers[0].expense.id).toBe(answers[1].expense.id);
    expect(await rowsFor(body.clientId)).toBe(1);
  });

  it("refuses the same clientId with a different body, and keeps the original", async () => {
    const body = expenseBody(group);
    const { expense } = await added(token, body);

    const response = await postExpense(token, { ...body, amount: "100.01" });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("client_id_conflict");
    expect(await rowsFor(body.clientId)).toBe(1);
    expect((await readGroup(token)).expenses.find((item) => item.id === expense.id)?.amount).toBe("100.00");
  });
});

describe("limits and the group read", () => {
  it(
    "refuses the 501st live expense with limit_reached, while a retry of an earlier one still answers",
    async () => {
      const { token, group } = await startGroup();
      const row = await resolveGroup(db, token);
      if (row === null) throw new Error("the new group did not resolve");
      const first = expenseBody(group, { amount: "1.00" });
      for (let i = 0; i < MAX_LIVE_EXPENSES; i++) {
        const result = await addExpense(db, row, i === 0 ? first : expenseBody(group, { amount: "1.00" }));
        expect(result.ok).toBe(true);
      }

      const over = await postExpense(token, expenseBody(group));
      expect(over.status).toBe(409);
      expect(await errorCode(over)).toBe("limit_reached");

      const retry = await added(token, first, 200);
      expect(retry.group.settlement.expenseCount).toBe(MAX_LIVE_EXPENSES);
    },
    120_000,
  );

  it("shows expenses newest first and a plan whose transfers bring every balance to zero", async () => {
    const { token, group } = await startGroup({ members: ["Ana", "Ben", "Chen", "Dev"] });
    const [ana, ben, chen, dev] = ids(group);
    // PGlite's clock ticks in milliseconds, unlike Postgres's microseconds, so the adds are spaced to get distinct times.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    await added(token, expenseBody(group, { description: "Rent", amount: "1200.00", paidBy: ana }));
    await tick();
    await added(
      token,
      expenseBody(group, { description: "Groceries", amount: "85.40", paidBy: ben, split: { mode: "equal", members: [ana, ben, chen] } }),
    );
    await tick();
    await added(
      token,
      expenseBody(group, {
        description: "Taxi",
        amount: "30.00",
        paidBy: chen,
        split: {
          mode: "shares",
          parts: [
            { memberId: dev, weight: 2 },
            { memberId: chen, weight: 1 },
          ],
        },
      }),
    );

    const view = await readGroup(token);

    expect(view.expenses.map((item) => item.description)).toEqual(["Taxi", "Groceries", "Rent"]);
    expect(view.settlement.expenseCount).toBe(3);
    const left = new Map(view.balances.map((row) => [row.memberId, toMinor(row.amount)]));
    const owing = [...left.values()].filter((amount) => amount !== BigInt(0)).length;
    expect(view.settlement.transfers.length).toBeGreaterThan(0);
    expect(view.settlement.transfers.length).toBeLessThan(owing);
    for (const transfer of view.settlement.transfers) {
      left.set(transfer.from, (left.get(transfer.from) ?? BigInt(0)) + toMinor(transfer.amount));
      left.set(transfer.to, (left.get(transfer.to) ?? BigInt(0)) - toMinor(transfer.amount));
    }
    expect([...left.values()].every((amount) => amount === BigInt(0))).toBe(true);
  });
});

// Not covered: the page's Edit and Delete buttons and how the form refills (that needs a browser), a removed member in
// an edit (removal is not built yet), rate limits, or the Neon driver (PGlite here, where transactions never overlap).
import { and, asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, expenseParts, expenses } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type {
  AddExpenseRequest,
  AddExpenseResponse,
  DeleteExpenseResponse,
  EditExpenseRequest,
  ExpenseView,
  GroupView,
} from "@/lib/api-types";
import { mintGroupToken } from "@/lib/group-token";
import {
  deleteExpense,
  editBody,
  errorCode,
  expenseBody,
  patchExpense,
  postExpense,
  readGroup,
  startGroup,
} from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

const NOT_FOUND_BODY = '{"error":{"code":"not_found"}}';

type Dinner = { token: string; group: GroupView; expense: ExpenseView; body: AddExpenseRequest };

// Ana paid 90.00 for all three, so Ana is owed 60.00 and Ben and Chen owe 30.00 each.
async function groupWithDinner(): Promise<Dinner> {
  const { token, group } = await startGroup();
  const body = expenseBody(group, { amount: "90.00" });
  const response = await postExpense(token, body);
  expect(response.status).toBe(201);
  const { expense } = (await response.json()) as AddExpenseResponse;
  return { token, group: await readGroup(token), expense, body };
}

async function edited(token: string, expenseId: string, body: EditExpenseRequest): Promise<AddExpenseResponse> {
  const response = await patchExpense(token, expenseId, body);
  expect(response.status).toBe(200);
  return (await response.json()) as AddExpenseResponse;
}

async function deleted(token: string, expenseId: string, version: number): Promise<DeleteExpenseResponse> {
  const response = await deleteExpense(token, expenseId, version);
  expect(response.status).toBe(200);
  return (await response.json()) as DeleteExpenseResponse;
}

async function eventsIn(groupId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(events).where(eq(events.groupId, groupId));
  return row.n;
}

async function kindsFor(entityId: string): Promise<string[]> {
  const log = await db.select().from(events).where(eq(events.entityId, entityId)).orderBy(asc(events.seq));
  return log.map((row) => row.kind);
}

function ids(group: GroupView): string[] {
  return group.members.map((member) => member.id);
}

function amounts(group: GroupView): string[] {
  return group.balances.map((row) => row.amount);
}

describe("editing an expense", () => {
  it("changes the amount, the payer and the split, and the balances, both versions and the log follow", async () => {
    const { token, group, expense: before, body: added } = await groupWithDinner();
    const [ana, ben, chen] = ids(group);
    expect(amounts(group)).toEqual(["60.00", "-30.00", "-30.00"]);

    const { expense, group: after } = await edited(
      token,
      before.id,
      editBody(group, 1, {
        description: "Taxi home",
        amount: "60.00",
        paidBy: ben,
        split: {
          mode: "shares",
          parts: [
            { memberId: chen, weight: 1 },
            { memberId: ana, weight: 2 },
          ],
        },
      }),
    );

    expect(expense).toMatchObject({ id: before.id, description: "Taxi home", amount: "60.00", paidBy: ben, version: 2 });
    expect(expense.createdAt).toBe(before.createdAt);
    expect(expense.parts).toEqual([
      { memberId: ana, amount: "40.00", baseAmount: "40.00", weight: 2 },
      { memberId: chen, amount: "20.00", baseAmount: "20.00", weight: 1 },
    ]);
    expect(amounts(after)).toEqual(["-40.00", "60.00", "-20.00"]);
    expect(after.total).toBe("0.00");
    expect(after.expenses).toEqual([expense]);
    expect(after.version).toBe(group.version + 1);
    expect(await readGroup(token)).toEqual(after);

    const parts = await db.select().from(expenseParts).where(eq(expenseParts.expenseId, before.id));
    expect(parts.map((part) => [part.memberId, part.weight]).sort()).toEqual(
      [
        [ana, BigInt(2)],
        [chen, BigInt(1)],
      ].sort(),
    );
    const log = await db.select().from(events).where(eq(events.entityId, before.id)).orderBy(asc(events.seq));
    expect(log.map((row) => row.kind)).toEqual(["expense_added", "expense_edited"]);
    expect(log[1].payload).toEqual({
      expenseId: before.id,
      clientId: added.clientId,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      description: "Taxi home",
      currency: "EUR",
      amountMinor: "6000",
      rateUnits: null,
      rateScale: null,
      paidBy: ben,
      splitMode: "shares",
      parts: [
        { memberId: ana, weight: "2" },
        { memberId: chen, weight: "1" },
      ],
      version: 2,
    });
  });

  it("refuses a stale version with 409 stale_version and writes nothing", async () => {
    const { token, group, expense } = await groupWithDinner();
    await edited(token, expense.id, editBody(group, 1, { amount: "60.00" }));
    const snapshot = await readGroup(token);
    const logged = await eventsIn(group.id);

    for (const version of [1, 3]) {
      const response = await patchExpense(token, expense.id, editBody(group, version, { amount: "30.00" }));
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("stale_version");
    }

    expect(await eventsIn(group.id)).toBe(logged);
    expect(await readGroup(token)).toEqual(snapshot);
    expect(snapshot.expenses[0]).toMatchObject({ amount: "60.00", version: 2 });
  });

  it("answers a retried identical edit with 200 and the edited expense, and writes nothing", async () => {
    const { token, group, expense } = await groupWithDinner();
    const body = editBody(group, 1, { amount: "60.00" });

    const first = await edited(token, expense.id, body);
    const logged = await eventsIn(group.id);
    const second = await edited(token, expense.id, body);

    expect(second).toEqual(first);
    expect(await eventsIn(group.id)).toBe(logged);

    // Only the edit that made the current version counts as a retry: another edit from version 1 is stale, and so is
    // the first one once a later edit has landed.
    const other = await patchExpense(token, expense.id, { ...body, amount: "45.00" });
    expect([other.status, await errorCode(other)]).toEqual([409, "stale_version"]);
    await edited(token, expense.id, editBody(group, 2, { amount: "75.00" }));
    const late = await patchExpense(token, expense.id, body);
    expect([late.status, await errorCode(late)]).toEqual([409, "stale_version"]);
    // Still refused once the expense holds this exact edit again, because version 1 is not the one just before.
    await edited(token, expense.id, editBody(group, 3, { amount: "60.00" }));
    const ancient = await patchExpense(token, expense.id, body);
    expect([ancient.status, await errorCode(ancient)]).toEqual([409, "stale_version"]);
  });

  it("lets one of two different edits from the same version land and refuses the other", async () => {
    const { token, group, expense } = await groupWithDinner();

    const responses = await Promise.all([
      patchExpense(token, expense.id, editBody(group, 1, { amount: "60.00" })),
      patchExpense(token, expense.id, editBody(group, 1, { amount: "30.00" })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await kindsFor(expense.id)).toEqual(["expense_added", "expense_edited"]);
    expect((await readGroup(token)).expenses[0].version).toBe(2);
  });

  it("answers 404 to an edit of a deleted expense, and writes nothing", async () => {
    const { token, group, expense } = await groupWithDinner();
    await deleted(token, expense.id, 1);
    const logged = await eventsIn(group.id);

    const response = await patchExpense(token, expense.id, editBody(group, 1, { amount: "60.00" }));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
    expect(await eventsIn(group.id)).toBe(logged);
  });

  it("still answers a retried add with 200 and the expense after it was edited", async () => {
    const { token, group, expense, body } = await groupWithDinner();
    const [row] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    const { expense: changed } = await edited(token, expense.id, editBody(group, 1, { amount: "60.00" }));

    const retry = await postExpense(token, body);

    expect(retry.status).toBe(200);
    expect(((await retry.json()) as AddExpenseResponse).expense).toEqual(changed);
    const [after] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    expect(after.requestHash).toBe(row.requestHash);
  });
});

describe("edit refusals", () => {
  let dinner: Dinner;

  beforeAll(async () => {
    dinner = await groupWithDinner();
  });

  it.each([
    ["amount_format", { amount: "1e3" }],
    ["amount_zero", { amount: "0.00" }],
    ["bad_currency", { currency: "eur" }],
    ["bad_description", { description: "  " }],
    ["rate_required", { currency: "USD", rate: null }],
    ["rate_forbidden", { rate: "1" }],
    ["split_empty", { split: { mode: "equal", members: [] } }],
    ["invalid_body", { clientId: "test-client-id" }],
    ["invalid_body", { groupId: "anything" }],
    ["invalid_body", { version: 0 }],
    ["invalid_body", { version: -1 }],
    ["invalid_body", { version: 1.5 }],
    ["invalid_body", { version: "1" }],
    ["invalid_body", { version: null }],
    ["invalid_body", { version: 2_147_483_648 }],
    ["invalid_body", { paidBy: "x".repeat(17 * 1024) }],
  ])("answers 400 %s for %j and writes nothing", async (code, overrides) => {
    const { token, group, expense } = dinner;
    const logged = await eventsIn(group.id);

    const response = await patchExpense(token, expense.id, { ...editBody(group, 1), ...overrides });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await eventsIn(group.id)).toBe(logged);
    expect((await readGroup(token)).expenses[0]).toEqual(expense);
  });

  it("refuses a body without the version", async () => {
    const { token, group, expense } = dinner;
    const body: Partial<EditExpenseRequest> = editBody(group, 1);
    delete body.version;

    expect(await errorCode(await patchExpense(token, expense.id, body))).toBe("invalid_body");
  });
});

describe("one group cannot reach another", () => {
  let a: Dinner;
  let b: Dinner;

  beforeAll(async () => {
    a = await groupWithDinner();
    b = await groupWithDinner();
  });

  it("answers 404 to an edit or a delete of another group's expense, and that group is unchanged", async () => {
    const otherBefore = await readGroup(b.token);

    const edit = await patchExpense(a.token, b.expense.id, editBody(a.group, 1, { amount: "1.00" }));
    const remove = await deleteExpense(a.token, b.expense.id, 1);

    expect([edit.status, remove.status]).toEqual([404, 404]);
    expect([await edit.text(), await remove.text()]).toEqual([NOT_FOUND_BODY, NOT_FOUND_BODY]);
    expect(await readGroup(b.token)).toEqual(otherBefore);
    expect(await kindsFor(b.expense.id)).toEqual(["expense_added"]);
  });

  const foreignIds: [string, (mine: string, theirs: string) => Partial<EditExpenseRequest>][] = [
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

  it.each(foreignIds)("answers 404 when %s belongs to another group, and changes neither group", async (_label, pick) => {
    const mineBefore = await readGroup(a.token);
    const otherBefore = await readGroup(b.token);

    const response = await patchExpense(a.token, a.expense.id, editBody(a.group, 1, pick(ids(a.group)[0], ids(b.group)[1])));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
    expect(await readGroup(a.token)).toEqual(mineBefore);
    expect(await readGroup(b.token)).toEqual(otherBefore);
  });

  it("answers an unknown token with the plain 404 on both routes", async () => {
    const stranger = mintGroupToken().token;

    const edit = await patchExpense(stranger, a.expense.id, editBody(a.group, 1));
    const remove = await deleteExpense(stranger, a.expense.id, 1);

    expect([edit.status, remove.status]).toEqual([404, 404]);
    expect([await edit.text(), await remove.text()]).toEqual([NOT_FOUND_BODY, NOT_FOUND_BODY]);
  });
});

describe("deleting an expense", () => {
  it("drops the expense from the list, the balances and the plan, and keeps the row marked deleted", async () => {
    const { token, group, expense } = await groupWithDinner();
    const taxi = await postExpense(token, expenseBody(group, { description: "Taxi", amount: "30.00", paidBy: ids(group)[1] }));
    expect(taxi.status).toBe(201);
    const before = await readGroup(token);

    const { group: after } = await deleted(token, expense.id, 1);

    expect(after.expenses.map((item) => item.description)).toEqual(["Taxi"]);
    expect(amounts(after)).toEqual(["-10.00", "20.00", "-10.00"]);
    expect(after.settlement.expenseCount).toBe(1);
    expect(after.version).toBe(before.version + 1);
    expect(await readGroup(token)).toEqual(after);
    const [row] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.amountMinor).toBe(BigInt(9000));
  });

  it("answers a second delete with 200, whatever its version, and writes one expense_deleted event in all", async () => {
    const { token, expense } = await groupWithDinner();

    const first = await deleted(token, expense.id, 1);
    const second = await deleted(token, expense.id, 1);
    const third = await deleted(token, expense.id, 7);

    expect(second.group).toEqual(first.group);
    expect(third.group).toEqual(first.group);
    expect(await kindsFor(expense.id)).toEqual(["expense_added", "expense_deleted"]);
    const [log] = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, expense.id), eq(events.kind, "expense_deleted")));
    expect(log.payload).toEqual({ expenseId: expense.id });
  });

  it("refuses a delete from a stale version with 409, and the expense stays", async () => {
    const { token, group, expense } = await groupWithDinner();
    await edited(token, expense.id, editBody(group, 1, { amount: "60.00" }));
    const snapshot = await readGroup(token);

    const response = await deleteExpense(token, expense.id, 1);

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("stale_version");
    expect(await readGroup(token)).toEqual(snapshot);
    expect(await kindsFor(expense.id)).toEqual(["expense_added", "expense_edited"]);
  });

  // Most of these would read as version 1 to a lenient parser, and so delete the expense. "+1" arrives as " 1".
  it.each([null, "", "+1", "01", "1.0", "1e0", "%201", "0x1", "%EF%BC%91", "1&version=1", "0", "-1", "2147483648"])(
    "answers 400 invalid_body to ?version=%s and keeps the expense",
    async (version) => {
      const { token, group, expense } = await groupWithDinner();
      const logged = await eventsIn(group.id);

      const response = await deleteExpense(token, expense.id, version);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_body");
      expect(await eventsIn(group.id)).toBe(logged);
    },
  );
});

describe("malformed ids", () => {
  it.each([
    ["not a uuid", "abc"],
    ["a uuid with an extra character", `${crypto.randomUUID()}0`],
    ["a uuid in braces", `{${crypto.randomUUID()}}`],
    ["a uuid without dashes", crypto.randomUUID().replaceAll("-", "")],
    ["a well formed id that matches nothing", crypto.randomUUID()],
  ])("answer %s with the plain 404 on both routes", async (_label, expenseId) => {
    const { token, group } = await startGroup();

    const edit = await patchExpense(token, expenseId, editBody(group, 1));
    const remove = await deleteExpense(token, expenseId, 1);

    expect([edit.status, remove.status]).toEqual([404, 404]);
    expect([await edit.text(), await remove.text()]).toEqual([NOT_FOUND_BODY, NOT_FOUND_BODY]);
  });
});

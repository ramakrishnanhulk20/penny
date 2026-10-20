// Not covered: two writers racing for the last place under a cap (PGlite runs one transaction at a time; every cap is
// counted under the group row lock); how long the counts take on Neon with a full log; the page's message for a full
// group; and the live caps of 500 expenses and 500 payments, which test/api-expenses.test.ts and
// test/api-payments.test.ts cover. The seeded rows go in through SQL, so on purpose they skip the store's own checks.
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, expenses, payments } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { AddExpenseResponse, AddPaymentResponse, GroupView } from "@/lib/api-types";
import { newLinkToken } from "@/lib/client/api";
import { MAX_EVENTS, MAX_EXPENSE_ROWS, MAX_PAYMENT_ROWS } from "@/lib/ledger-store";
import {
  deleteExpense,
  deleteMember,
  deletePayment,
  editBody,
  errorCode,
  expenseBody,
  getGroup,
  patchExpense,
  patchGroup,
  paymentBody,
  postExpense,
  postMember,
  postPayment,
  postResetLink,
  readGroup,
  startGroup,
} from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const LIMIT_REACHED = '{"error":{"code":"limit_reached"}}';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

async function eventCount(groupId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(events).where(eq(events.groupId, groupId));
  return row.n;
}

async function rowCount(table: typeof expenses | typeof payments, groupId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(eq(table.groupId, groupId));
  return row.n;
}

// Tops the group's log up to `total` events of a kind the store never writes.
async function fillLog(groupId: string, total: number): Promise<void> {
  const missing = total - (await eventCount(groupId));
  await db.execute(
    sql`insert into events (group_id, kind, entity_id, payload)
        select ${groupId}::uuid, 'seeded', null, '{}'::jsonb from generate_series(1, ${missing}::int)`,
  );
}

// `rows` expenses of 1.00 paid by `paidBy`, every one already deleted, so none counts against the live cap.
async function seedDeletedExpenses(group: GroupView, rows: number): Promise<void> {
  await db.execute(
    sql`insert into expenses (group_id, client_id, request_hash, description, currency, amount_minor, paid_by, split_mode,
                              deleted_at)
        select ${group.id}::uuid, 'seeded-' || i, 'seeded', 'Seeded', ${group.baseCurrency}, 100,
               ${group.members[0].id}::uuid, 'equal', now()
        from generate_series(1, ${rows}::int) as i`,
  );
}

// `rows` payments of 1.00 from the second member to the first, every one already undone.
async function seedUndonePayments(group: GroupView, rows: number): Promise<void> {
  await db.execute(
    sql`insert into payments (group_id, client_id, request_hash, from_member, to_member, currency, amount_minor,
                              deleted_at)
        select ${group.id}::uuid, 'seeded-' || i, 'seeded', ${group.members[1].id}::uuid, ${group.members[0].id}::uuid,
               ${group.baseCurrency}, 100, now()
        from generate_series(1, ${rows}::int) as i`,
  );
}

async function refused(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

describe("the event cap", () => {
  let token: string;
  let group: GroupView;
  let expense: { id: string; version: number };
  let paymentId: string;
  let removable: string;
  let earlierAdd: ReturnType<typeof expenseBody>;

  beforeAll(async () => {
    const started = await startGroup();
    token = started.token;
    earlierAdd = expenseBody(started.group);
    expense = ((await (await postExpense(token, earlierAdd)).json()) as AddExpenseResponse).expense;
    paymentId = ((await (await postPayment(token, paymentBody(await readGroup(token)))).json()) as AddPaymentResponse).payment.id;
    removable = (await (await postMember(token, { name: "Dev" })).json()).member.id;
    group = await readGroup(token);
    await fillLog(group.id, MAX_EVENTS - 1);
  });

  it("takes the write that brings the log to 10,000 events, then refuses the next with 409 limit_reached", async () => {
    expect((await postMember(token, { name: "Eve" })).status).toBe(201);
    expect(await eventCount(group.id)).toBe(MAX_EVENTS);

    expect(await refused(await postMember(token, { name: "Fay" }))).toEqual({ status: 409, body: LIMIT_REACHED });
    expect(await eventCount(group.id)).toBe(MAX_EVENTS);
  });

  it.each([
    ["adding an expense", () => postExpense(token, expenseBody(group))],
    ["editing an expense", () => patchExpense(token, expense.id, editBody(group, expense.version, { amount: "7.00" }))],
    ["deleting an expense", () => deleteExpense(token, expense.id, expense.version)],
    ["adding a payment", async () => postPayment(token, paymentBody(await readGroup(token)))],
    ["undoing a payment", () => deletePayment(token, paymentId)],
    ["adding a member", () => postMember(token, { name: "Gus" })],
    ["removing a member", () => deleteMember(token, removable)],
  ])("refuses %s at the cap with 409 limit_reached and changes nothing", async (_label, send) => {
    const before = await readGroup(token);

    expect(await refused(await send())).toEqual({ status: 409, body: LIMIT_REACHED });

    expect(await eventCount(group.id)).toBe(MAX_EVENTS);
    expect(await readGroup(token)).toEqual(before);
  });

  it("refuses a base currency change at the cap, in a group with no money yet", async () => {
    const fresh = await startGroup();
    await fillLog(fresh.group.id, MAX_EVENTS);

    expect(await refused(await patchGroup(fresh.token, { baseCurrency: "USD" }))).toEqual({
      status: 409,
      body: LIMIT_REACHED,
    });
    expect((await readGroup(fresh.token)).baseCurrency).toBe("EUR");
  });

  it("still reads, and still answers a retry that writes nothing", async () => {
    const read = await getGroup(token);
    expect(read.status).toBe(200);

    const retry = await postExpense(token, earlierAdd);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as AddExpenseResponse).expense.id).toBe(expense.id);
    expect(await eventCount(group.id)).toBe(MAX_EVENTS);
  });
});

describe("a link reset at the event cap", () => {
  it("still resets the link of a group at 10,000 events, and the group still cannot add an expense", async () => {
    const { token, group } = await startGroup();
    await fillLog(group.id, MAX_EVENTS);
    const newToken = newLinkToken();

    const reset = await postResetLink(token, { newToken });

    expect(reset.status).toBe(200);
    expect(await eventCount(group.id)).toBe(MAX_EVENTS + 1);
    expect((await getGroup(token)).status).toBe(404);
    const view = await readGroup(newToken);
    expect(view.id).toBe(group.id);

    expect(await refused(await postExpense(newToken, expenseBody(view)))).toEqual({ status: 409, body: LIMIT_REACHED });
    expect(await eventCount(group.id)).toBe(MAX_EVENTS + 1);
  });
});

describe("the expense row cap", () => {
  it("counts deleted expenses: refuses the 2,001st row with 409 limit_reached, and a delete frees no place", async () => {
    const { token, group } = await startGroup();
    await seedDeletedExpenses(group, MAX_EXPENSE_ROWS - 1);

    const last = await postExpense(token, expenseBody(group));
    expect(last.status).toBe(201);
    const { expense } = (await last.json()) as AddExpenseResponse;
    expect(await rowCount(expenses, group.id)).toBe(MAX_EXPENSE_ROWS);

    const over = await postExpense(token, expenseBody(group));
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe("limit_reached");

    expect((await deleteExpense(token, expense.id, expense.version)).status).toBe(200);
    const afterDelete = await postExpense(token, expenseBody(group));
    expect(afterDelete.status).toBe(409);
    expect(await errorCode(afterDelete)).toBe("limit_reached");
    expect(await rowCount(expenses, group.id)).toBe(MAX_EXPENSE_ROWS);
  });

  it("leaves payments and the group read alone", async () => {
    const { token, group } = await startGroup();
    await seedDeletedExpenses(group, MAX_EXPENSE_ROWS);

    expect((await postExpense(token, expenseBody(group))).status).toBe(409);
    expect((await postPayment(token, paymentBody(group))).status).toBe(201);
    expect((await getGroup(token)).status).toBe(200);
  });
});

describe("the payment row cap", () => {
  it("counts undone payments: refuses the 2,001st row with 409 limit_reached, and an undo frees no place", async () => {
    const { token, group } = await startGroup();
    await seedUndonePayments(group, MAX_PAYMENT_ROWS - 1);

    const last = await postPayment(token, paymentBody(group));
    expect(last.status).toBe(201);
    const { payment } = (await last.json()) as AddPaymentResponse;
    expect(await rowCount(payments, group.id)).toBe(MAX_PAYMENT_ROWS);

    const over = await postPayment(token, paymentBody(await readGroup(token)));
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe("limit_reached");

    expect((await deletePayment(token, payment.id)).status).toBe(200);
    const afterUndo = await postPayment(token, paymentBody(await readGroup(token)));
    expect(afterUndo.status).toBe(409);
    expect(await errorCode(afterUndo)).toBe("limit_reached");
    expect(await rowCount(payments, group.id)).toBe(MAX_PAYMENT_ROWS);
  });

  it("leaves expenses and the group read alone", async () => {
    const { token, group } = await startGroup();
    await seedUndonePayments(group, MAX_PAYMENT_ROWS);

    expect((await postPayment(token, paymentBody(group))).status).toBe(409);
    expect((await postExpense(token, expenseBody(group))).status).toBe(201);
    expect((await getGroup(token)).status).toBe(200);
  });
});

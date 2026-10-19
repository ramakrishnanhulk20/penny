// Not covered: the page's buttons and how it builds each clientId (that needs a browser), a removed member in a
// payment (removal is not built yet), rate limits, or the Neon driver (PGlite here, where transactions never overlap).
import { and, asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, payments } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type {
  AddPaymentRequest,
  AddPaymentResponse,
  CreateGroupResponse,
  GroupView,
  UndoPaymentResponse,
} from "@/lib/api-types";
import { mintGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { addPayment, MAX_LIVE_PAYMENTS } from "@/lib/ledger-store";
import {
  deletePayment,
  errorCode,
  expenseBody,
  paymentBody,
  postExpense,
  postPayment,
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

async function paymentRows(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(payments);
  return row.n;
}

async function paid(token: string, body: AddPaymentRequest, status = 201): Promise<AddPaymentResponse> {
  const response = await postPayment(token, body);
  expect(response.status).toBe(status);
  return (await response.json()) as AddPaymentResponse;
}

async function undone(token: string, paymentId: string): Promise<UndoPaymentResponse> {
  const response = await deletePayment(token, paymentId);
  expect(response.status).toBe(200);
  return (await response.json()) as UndoPaymentResponse;
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

// Ana paid 90.00 for all three, so Ana is owed 60.00 and Ben and Chen owe 30.00 each.
async function groupWithDinner(): Promise<CreateGroupResponse> {
  const started = await startGroup();
  const response = await postExpense(started.token, expenseBody(started.group, { amount: "90.00" }));
  expect(response.status).toBe(201);
  return { token: started.token, group: await readGroup(started.token) };
}

describe("recording a payment", () => {
  it("answers 201, moves both balances, writes one complete event and moves the version on", async () => {
    const { token, group } = await groupWithDinner();
    const [ana, ben] = ids(group);
    const body = paymentBody(group, { from: ben, to: ana, amount: "30.00" });

    const { payment, group: after } = await paid(token, body);

    expect(payment).toEqual({
      id: expect.any(String),
      from: ben,
      to: ana,
      currency: "EUR",
      amount: "30.00",
      rate: null,
      baseAmount: "30.00",
      createdAt: expect.any(String),
    });
    expect(after.payments).toEqual([payment]);
    expect(amounts(after)).toEqual(["30.00", "0.00", "-30.00"]);
    expect(after.total).toBe("0.00");
    expect(after.settlement.expenseCount).toBe(1);
    expect(after.version).toBe(group.version + 1);
    expect(await readGroup(token)).toEqual(after);

    const log = await db.select().from(events).where(eq(events.entityId, payment.id));
    expect(log.map((row) => row.kind)).toEqual(["payment_added"]);
    expect(log[0].payload).toEqual({
      paymentId: payment.id,
      clientId: body.clientId,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      from: ben,
      to: ana,
      currency: "EUR",
      amountMinor: "3000",
      rateUnits: null,
      rateScale: null,
    });
  });

  it("brings every balance to 0.00 and the plan to empty once every planned transfer is paid, newest first", async () => {
    const { token, group } = await startGroup({ members: ["Ana", "Ben", "Chen", "Dev"] });
    const [ana, ben, chen, dev] = ids(group);
    for (const expense of [
      expenseBody(group, { amount: "1200.00", paidBy: ana }),
      expenseBody(group, { amount: "85.40", paidBy: ben, split: { mode: "equal", members: [ana, ben, chen] } }),
      expenseBody(group, { amount: "30.00", paidBy: chen, split: { mode: "equal", members: [dev, chen] } }),
    ]) {
      expect((await postExpense(token, expense)).status).toBe(201);
    }
    const plan = (await readGroup(token)).settlement.transfers;
    expect(plan.length).toBeGreaterThan(1);

    const made: string[] = [];
    for (const transfer of plan) {
      const body = paymentBody(group, { from: transfer.from, to: transfer.to, amount: transfer.amount });
      made.push((await paid(token, body)).payment.id);
      // PGlite's clock ticks in milliseconds, so the payments are spaced to get distinct times.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const view = await readGroup(token);
    expect(amounts(view)).toEqual(["0.00", "0.00", "0.00", "0.00"]);
    expect(view.settlement.transfers).toEqual([]);
    expect(view.payments.map((payment) => payment.id)).toEqual([...made].reverse());
  });

  it("takes a payment in another currency at a rate, valued once in the base currency", async () => {
    const { token, group } = await groupWithDinner();

    const { payment, group: after } = await paid(token, paymentBody(group, { currency: "USD", amount: "20.00", rate: "1.5" }));

    expect(payment).toMatchObject({ currency: "USD", amount: "20.00", rate: "1.5", baseAmount: "30.00" });
    expect(amounts(after)).toEqual(["30.00", "0.00", "-30.00"]);
  });
});

describe("refusals", () => {
  let token: string;
  let group: GroupView;

  beforeAll(async () => {
    ({ token, group } = await groupWithDinner());
  });

  it("refuses a payment to yourself with 400 self_payment and writes nothing", async () => {
    const before = await paymentRows();

    const response = await postPayment(token, paymentBody(group, { from: group.members[0].id, to: group.members[0].id }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("self_payment");
    expect(await paymentRows()).toBe(before);
  });

  it.each([
    ["invalid_body", { clientId: "short" }],
    ["invalid_body", { amount: 30 }],
    ["invalid_body", { groupId: "anything" }],
    ["bad_currency", { currency: "eur" }],
    ["amount_format", { amount: "1e3" }],
    ["amount_too_many_decimals", { amount: "1.005" }],
    ["amount_zero", { amount: "0.00" }],
    ["amount_too_large", { amount: "10000000000.01" }],
    ["rate_required", { currency: "USD", rate: null }],
    ["rate_forbidden", { rate: "1" }],
    ["rate_format", { currency: "USD", rate: "0,92" }],
    ["converts_to_zero", { currency: "USD", amount: "0.01", rate: "0.0001" }],
    ["base_too_large", { currency: "USD", amount: "10000000000.00", rate: "2" }],
  ])("answers 400 %s for %j and writes nothing", async (code, overrides) => {
    const before = await paymentRows();

    const response = await postPayment(token, { ...paymentBody(group), ...overrides });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(await paymentRows()).toBe(before);
  });

  it("refuses a body over 16 KB with invalid_body, before any member check could answer 404", async () => {
    const response = await postPayment(token, paymentBody(group, { from: "x".repeat(17 * 1024) }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_body");
  });
});

describe("one group cannot reach another", () => {
  let a: CreateGroupResponse;
  let b: CreateGroupResponse;
  let theirPayment: string;

  beforeAll(async () => {
    a = await groupWithDinner();
    b = await groupWithDinner();
    theirPayment = (await paid(b.token, paymentBody(b.group, { clientId: "shared-client-id" }))).payment.id;
  });

  it.each([
    ["from", (mine: string[], theirs: string[]) => ({ from: theirs[1], to: mine[0] })],
    ["to", (mine: string[], theirs: string[]) => ({ from: mine[1], to: theirs[0] })],
    ["from and to", (_mine: string[], theirs: string[]) => ({ from: theirs[1], to: theirs[0] })],
  ])("answers 404 when %s belongs to another group, and changes neither group", async (_label, pick) => {
    const otherBefore = await readGroup(b.token);
    const before = await paymentRows();

    const response = await postPayment(a.token, paymentBody(a.group, pick(ids(a.group), ids(b.group))));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
    expect(await paymentRows()).toBe(before);
    expect((await readGroup(a.token)).payments).toEqual([]);
    expect(await readGroup(b.token)).toEqual(otherBefore);
  });

  it("answers 404 to an undo of another group's payment, and that payment stays", async () => {
    const otherBefore = await readGroup(b.token);

    const response = await deletePayment(a.token, theirPayment);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
    expect(await readGroup(b.token)).toEqual(otherBefore);
    expect(await kindsFor(theirPayment)).toEqual(["payment_added"]);
  });

  it("treats a clientId used in another group as new, and never returns that group's payment", async () => {
    const { payment } = await paid(a.token, paymentBody(a.group, { clientId: "shared-client-id" }), 201);

    expect(payment.id).not.toBe(theirPayment);
    expect(payment.from).toBe(a.group.members[1].id);
  });

  it("answers an unknown token with the plain 404 on both routes", async () => {
    const stranger = mintGroupToken().token;

    const post = await postPayment(stranger, paymentBody(a.group));
    const remove = await deletePayment(stranger, theirPayment);

    expect([post.status, remove.status]).toEqual([404, 404]);
    expect([await post.text(), await remove.text()]).toEqual([NOT_FOUND_BODY, NOT_FOUND_BODY]);
  });
});

describe("retries", () => {
  let token: string;
  let group: GroupView;

  beforeAll(async () => {
    ({ token, group } = await groupWithDinner());
  });

  async function rowsFor(clientId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(payments)
      .where(and(eq(payments.groupId, group.id), eq(payments.clientId, clientId)));
    return row.n;
  }

  it("answers a repeat with 200 and the same payment, keeps one row and one event, and leaves the version", async () => {
    const body = paymentBody(group);

    const first = await paid(token, body, 201);
    const second = await paid(token, body, 200);

    expect(second.payment).toEqual(first.payment);
    expect(second.group.version).toBe(first.group.version);
    expect(await rowsFor(body.clientId)).toBe(1);
    expect(await kindsFor(first.payment.id)).toEqual(["payment_added"]);
  });

  it("writes one row when the same request arrives twice at once", async () => {
    const body = paymentBody(group);

    const responses = await Promise.all([postPayment(token, body), postPayment(token, body)]);
    const answers = await Promise.all(responses.map(async (r) => ({ status: r.status, ...(await r.json()) })));

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(answers[0].payment.id).toBe(answers[1].payment.id);
    expect(await rowsFor(body.clientId)).toBe(1);
  });

  it("refuses the same clientId with a different body with 409, and keeps the original", async () => {
    const body = paymentBody(group);
    const { payment } = await paid(token, body);

    const response = await postPayment(token, { ...body, amount: "10.01" });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("client_id_conflict");
    expect(await rowsFor(body.clientId)).toBe(1);
    expect((await readGroup(token)).payments.find((item) => item.id === payment.id)?.amount).toBe("10.00");
  });
});

describe("undo", () => {
  it("restores the balances and the plan, and leaves the row in place marked deleted", async () => {
    const { token, group: before } = await groupWithDinner();
    const { payment } = await paid(token, paymentBody(before, { amount: "30.00" }));

    const { group: after } = await undone(token, payment.id);

    expect(after.payments).toEqual([]);
    expect(after.balances).toEqual(before.balances);
    expect(after.settlement).toEqual(before.settlement);
    expect(await readGroup(token)).toEqual(after);
    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.amountMinor).toBe(BigInt(3000));
  });

  it("answers a second undo of the same payment with 200 and writes one payment_deleted event in all", async () => {
    const { token, group } = await groupWithDinner();
    const { payment } = await paid(token, paymentBody(group));

    const first = await undone(token, payment.id);
    const second = await undone(token, payment.id);

    expect(second.group).toEqual(first.group);
    expect(await kindsFor(payment.id)).toEqual(["payment_added", "payment_deleted"]);
    const [deleted] = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, payment.id), eq(events.kind, "payment_deleted")));
    expect(deleted.payload).toEqual({ paymentId: payment.id });
  });

  it("lets a line that was paid, undone and shown again be paid again, because each payment moves the version", async () => {
    const { token, group } = await groupWithDinner();
    const line = group.settlement.transfers[0];
    // The page keys a line's clientId on (version, from, to, amount); this stands in for its hash.
    const keyFor = (view: GroupView) => `line-${view.version}-${line.amount.replace(".", "")}-${line.from.slice(0, 8)}`;
    const body = (view: GroupView) =>
      paymentBody(view, { clientId: keyFor(view), from: line.from, to: line.to, amount: line.amount });

    const { payment } = await paid(token, body(group));
    const { group: shownAgain } = await undone(token, payment.id);
    expect(shownAgain.settlement.transfers).toContainEqual(line);
    expect(keyFor(shownAgain)).not.toBe(keyFor(group));

    const { payment: again } = await paid(token, body(shownAgain), 201);

    expect(again.id).not.toBe(payment.id);
    expect((await readGroup(token)).payments.map((item) => item.id)).toEqual([again.id]);
  });

  it.each([
    ["not a uuid", "abc"],
    ["a uuid with an extra character", `${crypto.randomUUID()}0`],
    ["a uuid in braces", `{${crypto.randomUUID()}}`],
    ["a uuid without dashes", crypto.randomUUID().replaceAll("-", "")],
    ["a well formed id that matches nothing", crypto.randomUUID()],
  ])("answers the plain 404 to %s", async (_label, paymentId) => {
    const { token } = await startGroup();

    const response = await deletePayment(token, paymentId);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
  });
});

describe("limits", () => {
  it(
    "refuses the 501st live payment with limit_reached, answers a retry, and takes a new one after an undo",
    async () => {
      const { token, group } = await startGroup();
      const row = await resolveGroup(db, token);
      if (row === null) throw new Error("the new group did not resolve");
      const first = paymentBody(group, { amount: "0.01" });
      let firstId = "";
      for (let i = 0; i < MAX_LIVE_PAYMENTS; i++) {
        const result = await addPayment(db, row, i === 0 ? first : paymentBody(group, { amount: "0.01" }));
        if (!result.ok) throw new Error(`seeding stopped at ${i}: ${result.code}`);
        if (i === 0) firstId = result.value.paymentId;
      }

      const over = await postPayment(token, paymentBody(group));
      expect(over.status).toBe(409);
      expect(await errorCode(over)).toBe("limit_reached");

      const retry = await paid(token, first, 200);
      expect(retry.group.payments).toHaveLength(MAX_LIVE_PAYMENTS);

      await undone(token, firstId);
      await paid(token, paymentBody(group), 201);
    },
    120_000,
  );
});

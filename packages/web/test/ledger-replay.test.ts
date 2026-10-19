// Not covered: member removal (not built yet), writers racing each other, or the database role that should forbid
// changing events (a deploy setting, not code).
import {
  balances,
  currency,
  formatAmount,
  formatRate,
  type Currency,
  type Entry,
  type Rate,
  type Split,
} from "@penny/core";
import { asc, count, eq, inArray } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type {
  AddExpenseRequest,
  AddExpenseResponse,
  AddPaymentRequest,
  AddPaymentResponse,
  EditExpenseRequest,
  GroupView,
  SplitRequest,
} from "@/lib/api-types";
import type {
  ExpenseAddedPayload,
  ExpenseDeletedPayload,
  ExpenseEditedPayload,
  PaymentAddedPayload,
  PaymentDeletedPayload,
} from "@/lib/ledger-store";
import { deleteExpense, deletePayment, patchExpense, postExpense, postPayment, readGroup, startGroup } from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

const CODES = ["EUR", "JPY", "KWD", "USD"] as const;
const NAMES = ["Ana", "Ben", "Chen", "Dev", "Eli", "Fay"];

function known(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error(`unknown currency ${code}`);
  return found;
}

function splitFrom(payload: ExpenseAddedPayload): Split {
  if (payload.splitMode === "equal") return { mode: "equal", members: payload.parts.map((part) => part.memberId) };
  if (payload.splitMode === "shares") {
    return { mode: "shares", parts: payload.parts.map((part) => ({ memberId: part.memberId, weight: Number(part.weight) })) };
  }
  return { mode: "exact", parts: payload.parts.map((part) => ({ memberId: part.memberId, amount: BigInt(part.weight) })) };
}

function rateFrom(units: string | null, scale: string | null): Rate | null {
  return units === null ? null : { units: BigInt(units), scale: Number(scale) };
}

function expenseFrom(payload: ExpenseAddedPayload): Entry {
  return {
    kind: "expense",
    id: payload.expenseId,
    paidBy: payload.paidBy,
    currency: known(payload.currency),
    amount: BigInt(payload.amountMinor),
    rate: rateFrom(payload.rateUnits, payload.rateScale),
    split: splitFrom(payload),
  };
}

type Rebuilt = {
  base: Currency;
  totals: ReadonlyMap<string, bigint>;
  /** Each live expense's id and the version the log says it is at. */
  expenses: [string, number][];
  payments: string[];
};

// Reads the events table and nothing else, so it checks the current-state tables instead of repeating them.
async function replay(groupId: string): Promise<Rebuilt> {
  const log = await db.select().from(events).where(eq(events.groupId, groupId)).orderBy(asc(events.seq));
  let base: Currency | null = null;
  const people: { id: string; position: number }[] = [];
  const liveExpenses = new Map<string, { entry: Entry; version: number }>();
  const livePayments = new Map<string, Entry>();
  for (const event of log) {
    if (event.kind === "group_created") {
      base = known((event.payload as { baseCurrency: string }).baseCurrency);
    } else if (event.kind === "member_added") {
      const { memberId, position } = event.payload as { memberId: string; position: number };
      people.push({ id: memberId, position });
    } else if (event.kind === "expense_added") {
      const payload = event.payload as ExpenseAddedPayload;
      liveExpenses.set(payload.expenseId, { entry: expenseFrom(payload), version: 1 });
    } else if (event.kind === "expense_edited") {
      const payload = event.payload as ExpenseEditedPayload;
      const prior = liveExpenses.get(payload.expenseId);
      if (prior === undefined) throw new Error(`expense_edited for an expense that is not live: ${payload.expenseId}`);
      if (payload.version !== prior.version + 1) throw new Error(`expense_edited skipped a version: ${payload.expenseId}`);
      liveExpenses.set(payload.expenseId, { entry: expenseFrom(payload), version: payload.version });
    } else if (event.kind === "expense_deleted") {
      const { expenseId } = event.payload as ExpenseDeletedPayload;
      if (!liveExpenses.delete(expenseId)) throw new Error(`expense_deleted for an expense that is not live: ${expenseId}`);
    } else if (event.kind === "payment_added") {
      const payload = event.payload as PaymentAddedPayload;
      livePayments.set(payload.paymentId, {
        kind: "payment",
        id: payload.paymentId,
        from: payload.from,
        to: payload.to,
        currency: known(payload.currency),
        amount: BigInt(payload.amountMinor),
        rate: rateFrom(payload.rateUnits, payload.rateScale),
      });
    } else if (event.kind === "payment_deleted") {
      const { paymentId } = event.payload as PaymentDeletedPayload;
      if (!livePayments.delete(paymentId)) throw new Error(`payment_deleted for a payment that is not live: ${paymentId}`);
    } else {
      throw new Error(`unexpected event ${event.kind}`);
    }
  }
  if (base === null) throw new Error("no group_created event");
  const order = people.sort((a, b) => a.position - b.position).map((person) => person.id);
  const spent = [...liveExpenses.values()].map((item) => item.entry);
  const totals = balances(base, order, [...spent, ...livePayments.values()]);
  if (!totals.ok) throw new Error(`the log does not replay: ${totals.error}`);
  return {
    base,
    totals: totals.value,
    expenses: [...liveExpenses].map(([id, item]) => [id, item.version]),
    payments: [...livePayments.keys()],
  };
}

const step = fc.record({
  action: fc.constantFrom("expense", "payment", "undo", "edit", "delete"),
  // One edit or delete in four names a version the expense was never at, which the API must refuse.
  stale: fc.nat({ max: 3 }).map((n) => n === 0),
  // One step in four repeats the one before, so most steps are new and an undo usually has a payment to find.
  retry: fc.nat({ max: 3 }).map((n) => n === 0),
  currency: fc.constantFrom(...CODES),
  amountMinor: fc.bigInt({ min: BigInt(1), max: BigInt(1_000_000) }),
  rateUnits: fc.bigInt({ min: BigInt(1), max: BigInt(100_000) }),
  rateScale: fc.integer({ min: 2, max: 6 }),
  payer: fc.nat({ max: NAMES.length - 1 }),
  payee: fc.nat({ max: NAMES.length - 1 }),
  mode: fc.constantFrom("equal", "shares", "exact"),
  weights: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: NAMES.length, maxLength: NAMES.length }),
  pick: fc.nat({ max: 20 }),
});

type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

function requestFor(group: GroupView, s: Step): AddExpenseRequest {
  const ids = group.members.map((member) => member.id);
  const picked = ids.map((id, i) => ({ id, weight: s.weights[i] })).filter((pick) => pick.weight > 0);
  const cur = known(s.currency);
  let split: SplitRequest;
  if (s.mode === "equal") {
    split = { mode: "equal", members: picked.map((pick) => pick.id) };
  } else if (s.mode === "shares") {
    split = { mode: "shares", parts: picked.map((pick) => ({ memberId: pick.id, weight: pick.weight })) };
  } else {
    // Proportional cuts with the rounding left to the first part; a cut of zero is a request the API must refuse.
    const weightSum = picked.reduce((sum, pick) => sum + BigInt(pick.weight), BigInt(0));
    const cuts = picked.map((pick) => (weightSum === BigInt(0) ? BigInt(0) : (s.amountMinor * BigInt(pick.weight)) / weightSum));
    if (cuts.length > 0) cuts[0] += s.amountMinor - cuts.reduce((sum, cut) => sum + cut, BigInt(0));
    split = {
      mode: "exact",
      parts: picked.map((pick, i) => ({ memberId: pick.id, amount: formatAmount(cuts[i], cur) })),
    };
  }
  return {
    clientId: `replay-${crypto.randomUUID()}`,
    description: "Replay",
    amount: formatAmount(s.amountMinor, cur),
    currency: s.currency,
    rate: s.currency === group.baseCurrency ? null : formatRate({ units: s.rateUnits, scale: s.rateScale }),
    paidBy: ids[s.payer % ids.length],
    split,
  };
}

// From and to can be the same member, a request the API must refuse with self_payment.
function paymentFor(group: GroupView, s: Step): AddPaymentRequest {
  const ids = group.members.map((member) => member.id);
  const cur = known(s.currency);
  return {
    clientId: `replay-${crypto.randomUUID()}`,
    from: ids[s.payer % ids.length],
    to: ids[s.payee % ids.length],
    amount: formatAmount(s.amountMinor, cur),
    currency: s.currency,
    rate: s.currency === group.baseCurrency ? null : formatRate({ units: s.rateUnits, scale: s.rateScale }),
  };
}

function editFor(group: GroupView, s: Step, version: number): EditExpenseRequest {
  const { description, amount, currency, rate, paidBy, split } = requestFor(group, s);
  return { version, description, amount, currency, rate, paidBy, split };
}

/** What the run has been told about one expense it added: the version the last answer gave, and whether it is gone. */
type Bill = { readonly id: string; version: number; deleted: boolean };

type Sent =
  | { kind: "expense"; body: AddExpenseRequest }
  | { kind: "payment"; body: AddPaymentRequest }
  | { kind: "undo"; paymentId: string; status: 200 | 404 }
  | { kind: "edit"; expenseId: string; body: EditExpenseRequest; statuses: readonly number[] }
  | { kind: "delete"; expenseId: string; version: number; statuses: readonly number[] };

function sentFor(group: GroupView, s: Step, made: readonly string[], bills: readonly Bill[]): Sent {
  if (s.action === "expense") return { kind: "expense", body: requestFor(group, s) };
  if (s.action === "payment") return { kind: "payment", body: paymentFor(group, s) };
  if (s.action === "undo") {
    // An undo picks any payment made so far, live or already undone; with none made yet it names an id nobody has.
    if (made.length === 0) return { kind: "undo", paymentId: crypto.randomUUID(), status: 404 };
    return { kind: "undo", paymentId: made[s.pick % made.length], status: 200 };
  }
  // The same for an edit or a delete, over the expenses added so far.
  if (bills.length === 0) {
    const expenseId = crypto.randomUUID();
    if (s.action === "edit") return { kind: "edit", expenseId, body: editFor(group, s, 1), statuses: [404] };
    return { kind: "delete", expenseId, version: 1, statuses: [404] };
  }
  const bill = bills[s.pick % bills.length];
  const version = s.stale ? bill.version + 1 : bill.version;
  if (s.action === "edit") {
    // The new values are checked before the version, so a stale edit with values the API refuses is a 400.
    const statuses = bill.deleted ? [404] : s.stale ? [400, 409] : [200, 400];
    return { kind: "edit", expenseId: bill.id, body: editFor(group, s, version), statuses };
  }
  return { kind: "delete", expenseId: bill.id, version, statuses: bill.deleted ? [200] : s.stale ? [409] : [200] };
}

const RUNS = 40;
// Picked once and never tuned to its results. The coverage test counts what this seed's sequences did, so its guards
// either always pass or always fail: they cannot fail by chance.
const COVERAGE_SEED = 20_261_019;

type Coverage = {
  /** Expenses and payments the API stored, retries left out. */
  stored: number;
  /** Edits answered 200 with no new version: retries of an edit that had already landed. */
  retriedEdits: number;
  /** Edits and deletes refused with 409 stale_version. */
  refusedStale: number;
  /** The events this run's groups wrote, by kind. */
  logged: ReadonlyMap<string, number>;
};

// The property: random sequences of changes against fresh groups, and each group's view checked against a replay of
// its own events. With no seed, fast-check picks a new one every time and prints it when a case fails.
async function exercise(seed?: number): Promise<Coverage> {
  let stored = 0;
  let retriedEdits = 0;
  let refusedStale = 0;
  const groupIds: string[] = [];

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...CODES),
      fc.integer({ min: 2, max: NAMES.length }),
      fc.array(step, { minLength: 1, maxLength: 12 }),
      async (base, size, steps) => {
        const { token, group } = await startGroup({ baseCurrency: base, members: NAMES.slice(0, size) });
        groupIds.push(group.id);
        const made: string[] = [];
        const bills: Bill[] = [];
        let previous: Sent | null = null;
        for (const s of steps) {
          const sent: Sent = s.retry && previous !== null ? previous : sentFor(group, s, made, bills);
          if (sent.kind === "expense") {
            const response = await postExpense(token, sent.body);
            expect([200, 201, 400]).toContain(response.status);
            if (response.status === 201) {
              stored += 1;
              bills.push({ id: ((await response.json()) as AddExpenseResponse).expense.id, version: 1, deleted: false });
            }
          } else if (sent.kind === "payment") {
            const response = await postPayment(token, sent.body);
            expect([200, 201, 400]).toContain(response.status);
            if (response.status === 201) {
              stored += 1;
              made.push(((await response.json()) as AddPaymentResponse).payment.id);
            }
          } else if (sent.kind === "undo") {
            expect((await deletePayment(token, sent.paymentId)).status).toBe(sent.status);
          } else if (sent.kind === "edit") {
            const response = await patchExpense(token, sent.expenseId, sent.body);
            expect(sent.statuses).toContain(response.status);
            if (response.status === 409) refusedStale += 1;
            if (response.status === 200) {
              const { expense } = (await response.json()) as AddExpenseResponse;
              const bill = bills.find((item) => item.id === expense.id);
              if (bill !== undefined && bill.version === expense.version) retriedEdits += 1;
              if (bill !== undefined) bill.version = expense.version;
            }
          } else {
            const response = await deleteExpense(token, sent.expenseId, sent.version);
            expect(sent.statuses).toContain(response.status);
            if (response.status === 409) refusedStale += 1;
            const bill = bills.find((item) => item.id === sent.expenseId);
            if (response.status === 200 && bill !== undefined) bill.deleted = true;
          }
          previous = sent;
        }

        const view = await readGroup(token);
        const rebuilt = await replay(view.id);

        expect(view.balances).toEqual(
          view.members.map((member) => ({
            memberId: member.id,
            amount: formatAmount(rebuilt.totals.get(member.id) ?? BigInt(0), rebuilt.base),
          })),
        );
        expect(view.settlement.expenseCount).toBe(rebuilt.expenses.length);
        const shown = view.expenses.map((expense) => [expense.id, expense.version]).sort();
        expect(shown).toEqual([...rebuilt.expenses].sort());
        // The answers the run was given tell the same story as the log.
        expect(shown).toEqual(bills.filter((bill) => !bill.deleted).map((bill) => [bill.id, bill.version]).sort());
        expect(view.payments.map((payment) => payment.id).sort()).toEqual([...rebuilt.payments].sort());
        expect(view.total).toBe(formatAmount(BigInt(0), rebuilt.base));
      },
    ),
    seed === undefined ? { numRuns: RUNS } : { numRuns: RUNS, seed },
  );

  const kinds = await db
    .select({ kind: events.kind, n: count() })
    .from(events)
    .where(inArray(events.groupId, groupIds))
    .groupBy(events.kind);
  return { stored, retriedEdits, refusedStale, logged: new Map(kinds.map((row) => [row.kind, row.n])) };
}

it("rebuilds the balances GroupView shows from the events table alone, after any sequence of adds, edits, deletes, payments and undos", async () => {
  await exercise();
}, 180_000);

// The random run above cannot guard its own coverage without sometimes failing by chance, so the same property runs
// again on a fixed seed and the guards count that run: they show the generator reaches every path the property is
// meant to check, not that a given random run did.
it("reaches every kind of change on a fixed seed, so the property cannot pass by testing nothing", async () => {
  const coverage = await exercise(COVERAGE_SEED);

  // On this seed the run stores 70 expenses and payments and logs 34 payments, 10 undos, 6 edits and 6 deletes, with
  // 4 retried edits and 7 stale refusals. Each floor sits near half of that, so it catches a run that went hollow
  // without breaking on a harmless change in which requests get refused.
  expect(coverage.stored).toBeGreaterThanOrEqual(35);
  expect(coverage.logged.get("payment_added") ?? 0).toBeGreaterThanOrEqual(17);
  expect(coverage.logged.get("payment_deleted") ?? 0).toBeGreaterThanOrEqual(5);
  expect(coverage.logged.get("expense_edited") ?? 0).toBeGreaterThanOrEqual(3);
  expect(coverage.logged.get("expense_deleted") ?? 0).toBeGreaterThanOrEqual(3);
  expect(coverage.retriedEdits).toBeGreaterThanOrEqual(2);
  expect(coverage.refusedStale).toBeGreaterThanOrEqual(3);
}, 180_000);

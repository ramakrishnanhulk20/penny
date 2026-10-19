// Not covered: expense edits and deletes and member removal (not built yet), writers racing each other, or the
// database role that should forbid changing events (a deploy setting, not code).
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
import { asc, count, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { AddExpenseRequest, AddPaymentRequest, AddPaymentResponse, GroupView, SplitRequest } from "@/lib/api-types";
import type { ExpenseAddedPayload, PaymentAddedPayload, PaymentDeletedPayload } from "@/lib/ledger-store";
import { deletePayment, postExpense, postPayment, readGroup, startGroup } from "./fixtures";

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

type Rebuilt = { base: Currency; totals: ReadonlyMap<string, bigint>; expenses: number; payments: string[] };

// Reads the events table and nothing else, so it checks the current-state tables instead of repeating them.
async function replay(groupId: string): Promise<Rebuilt> {
  const log = await db.select().from(events).where(eq(events.groupId, groupId)).orderBy(asc(events.seq));
  let base: Currency | null = null;
  const people: { id: string; position: number }[] = [];
  const spent: Entry[] = [];
  const livePayments = new Map<string, Entry>();
  for (const event of log) {
    if (event.kind === "group_created") {
      base = known((event.payload as { baseCurrency: string }).baseCurrency);
    } else if (event.kind === "member_added") {
      const { memberId, position } = event.payload as { memberId: string; position: number };
      people.push({ id: memberId, position });
    } else if (event.kind === "expense_added") {
      const payload = event.payload as ExpenseAddedPayload;
      spent.push({
        kind: "expense",
        id: payload.expenseId,
        paidBy: payload.paidBy,
        currency: known(payload.currency),
        amount: BigInt(payload.amountMinor),
        rate: rateFrom(payload.rateUnits, payload.rateScale),
        split: splitFrom(payload),
      });
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
  const totals = balances(base, order, [...spent, ...livePayments.values()]);
  if (!totals.ok) throw new Error(`the log does not replay: ${totals.error}`);
  return { base, totals: totals.value, expenses: spent.length, payments: [...livePayments.keys()] };
}

const step = fc.record({
  action: fc.constantFrom("expense", "payment", "undo"),
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

type Sent =
  | { kind: "expense"; body: AddExpenseRequest }
  | { kind: "payment"; body: AddPaymentRequest }
  | { kind: "undo"; paymentId: string; status: 200 | 404 };

function sentFor(group: GroupView, s: Step, made: readonly string[]): Sent {
  if (s.action === "expense") return { kind: "expense", body: requestFor(group, s) };
  if (s.action === "payment") return { kind: "payment", body: paymentFor(group, s) };
  // An undo picks any payment made so far, live or already undone; with none made yet it names an id nobody has.
  if (made.length === 0) return { kind: "undo", paymentId: crypto.randomUUID(), status: 404 };
  return { kind: "undo", paymentId: made[s.pick % made.length], status: 200 };
}

it("rebuilds the balances GroupView shows from the events table alone, after any sequence of adds, payments and undos", async () => {
  let stored = 0;
  const runs = 40;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...CODES),
      fc.integer({ min: 2, max: NAMES.length }),
      fc.array(step, { minLength: 1, maxLength: 12 }),
      async (base, size, steps) => {
        const { token, group } = await startGroup({ baseCurrency: base, members: NAMES.slice(0, size) });
        const made: string[] = [];
        let previous: Sent | null = null;
        for (const s of steps) {
          const sent: Sent = s.retry && previous !== null ? previous : sentFor(group, s, made);
          if (sent.kind === "expense") {
            const response = await postExpense(token, sent.body);
            expect([200, 201, 400]).toContain(response.status);
            if (response.status === 201) stored += 1;
          } else if (sent.kind === "payment") {
            const response = await postPayment(token, sent.body);
            expect([200, 201, 400]).toContain(response.status);
            if (response.status === 201) {
              stored += 1;
              made.push(((await response.json()) as AddPaymentResponse).payment.id);
            }
          } else {
            expect((await deletePayment(token, sent.paymentId)).status).toBe(sent.status);
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
        expect(view.settlement.expenseCount).toBe(rebuilt.expenses);
        expect(view.expenses).toHaveLength(rebuilt.expenses);
        expect(view.payments.map((payment) => payment.id).sort()).toEqual([...rebuilt.payments].sort());
        expect(view.total).toBe(formatAmount(BigInt(0), rebuilt.base));
      },
    ),
    { numRuns: runs },
  );

  // Guards against runs where every request was refused, or no payment was ever made or undone, so the property
  // held without testing anything.
  expect(stored).toBeGreaterThan(runs);
  const [added] = await db.select({ n: count() }).from(events).where(eq(events.kind, "payment_added"));
  const [deleted] = await db.select({ n: count() }).from(events).where(eq(events.kind, "payment_deleted"));
  // A simulation of this generator over 20,000 suites averaged 19 undos of a live payment and never went under 5.
  expect(added.n).toBeGreaterThan(runs / 4);
  expect(deleted.n).toBeGreaterThan(runs / 20);
}, 180_000);

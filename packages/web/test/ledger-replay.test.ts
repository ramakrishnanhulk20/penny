// Not covered: edits, deletes, payments and member removal (not built yet), writers racing each other, or the
// database role that should forbid changing events (a deploy setting, not code).
import { balances, currency, formatAmount, formatRate, type Currency, type Entry, type Split } from "@penny/core";
import { asc, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { AddExpenseRequest, GroupView, SplitRequest } from "@/lib/api-types";
import type { ExpenseAddedPayload } from "@/lib/ledger-store";
import { postExpense, readGroup, startGroup } from "./fixtures";

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

// Reads the events table and nothing else, so it checks the current-state tables instead of repeating them.
async function replay(groupId: string): Promise<{ base: Currency; totals: ReadonlyMap<string, bigint>; expenses: number }> {
  const log = await db.select().from(events).where(eq(events.groupId, groupId)).orderBy(asc(events.seq));
  let base: Currency | null = null;
  const people: { id: string; position: number }[] = [];
  const entries: Entry[] = [];
  for (const event of log) {
    if (event.kind === "group_created") {
      base = known((event.payload as { baseCurrency: string }).baseCurrency);
    } else if (event.kind === "member_added") {
      const { memberId, position } = event.payload as { memberId: string; position: number };
      people.push({ id: memberId, position });
    } else if (event.kind === "expense_added") {
      const payload = event.payload as ExpenseAddedPayload;
      entries.push({
        kind: "expense",
        id: payload.expenseId,
        paidBy: payload.paidBy,
        currency: known(payload.currency),
        amount: BigInt(payload.amountMinor),
        rate:
          payload.rateUnits === null ? null : { units: BigInt(payload.rateUnits), scale: Number(payload.rateScale) },
        split: splitFrom(payload),
      });
    } else {
      throw new Error(`unexpected event ${event.kind}`);
    }
  }
  if (base === null) throw new Error("no group_created event");
  const order = people.sort((a, b) => a.position - b.position).map((person) => person.id);
  const totals = balances(base, order, entries);
  if (!totals.ok) throw new Error(`the log does not replay: ${totals.error}`);
  return { base, totals: totals.value, expenses: entries.length };
}

const step = fc.record({
  retry: fc.boolean(),
  currency: fc.constantFrom(...CODES),
  amountMinor: fc.bigInt({ min: BigInt(1), max: BigInt(1_000_000) }),
  rateUnits: fc.bigInt({ min: BigInt(1), max: BigInt(100_000) }),
  rateScale: fc.integer({ min: 2, max: 6 }),
  payer: fc.nat({ max: NAMES.length - 1 }),
  mode: fc.constantFrom("equal", "shares", "exact"),
  weights: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: NAMES.length, maxLength: NAMES.length }),
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

it("rebuilds the balances GroupView shows from the events table alone, after any sequence of adds", async () => {
  let stored = 0;
  const runs = 40;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...CODES),
      fc.integer({ min: 2, max: NAMES.length }),
      fc.array(step, { minLength: 1, maxLength: 8 }),
      async (base, size, steps) => {
        const { token, group } = await startGroup({ baseCurrency: base, members: NAMES.slice(0, size) });
        let previous: AddExpenseRequest | null = null;
        for (const s of steps) {
          const body: AddExpenseRequest = s.retry && previous !== null ? previous : requestFor(group, s);
          const response = await postExpense(token, body);
          expect([200, 201, 400]).toContain(response.status);
          if (response.status === 201) stored += 1;
          previous = body;
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
        expect(view.total).toBe(formatAmount(BigInt(0), rebuilt.base));
      },
    ),
    { numRuns: runs },
  );

  // Guards against a run where every generated request was refused and the property held trivially.
  expect(stored).toBeGreaterThan(runs);
}, 180_000);

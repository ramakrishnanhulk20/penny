// Not covered: the landing page and its animation, which only show these strings; the group page drawing them in a
// browser (it calls the same settle-words functions this test calls, but nothing renders here); and Neon, since the
// server side runs on in-memory PGlite.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { createTestDb } from "@/db/testing";
import type { GroupView } from "@/lib/api-types";
import { createSampleTrip } from "@/lib/sample-trip";
import { sampleTripStory } from "@/lib/sample-trip-story";
import { balanceLine, proofLine } from "@/lib/settle-words";
import { readGroup } from "./fixtures";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

type Line = { readonly from: string; readonly to: string; readonly amount: string };

// Core's own ordering for a settle plan, applied to names instead of member ids.
function byPayerThenPayee(a: Line, b: Line): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

function namesOf(group: GroupView): (memberId: string) => string {
  const names = new Map(group.members.map((member) => [member.id, member.name]));
  return (memberId) => {
    const name = names.get(memberId);
    if (name === undefined) throw new Error(`unknown member ${memberId}`);
    return name;
  };
}

describe("sampleTripStory", () => {
  it("tells exactly the group that Try a sample trip makes on the server", async () => {
    const { token } = await createSampleTrip(db);
    const group = await readGroup(token);
    const story = sampleTripStory();
    const name = namesOf(group);

    expect(story.groupName).toBe(group.name);
    expect(story.baseCurrency).toBe(group.baseCurrency);
    expect(story.people).toEqual(group.members.map((member) => member.name));

    // The API lists expenses newest first, and two can share a timestamp, so each is matched by its description.
    const served = new Map(
      group.expenses.map((expense) => [
        expense.description,
        {
          description: expense.description,
          paidBy: name(expense.paidBy),
          amount: expense.amount,
          currency: expense.currency,
          rate: expense.rate,
          base: expense.baseAmount,
          parts: expense.parts.map((part) => ({ person: name(part.memberId), base: part.baseAmount })),
        },
      ]),
    );
    expect(served.size).toBe(story.expenses.length);
    expect(story.expenses).toEqual(story.expenses.map((told) => ({ id: told.id, ...served.get(told.description) })));

    expect(story.balances).toEqual(
      group.balances.map((row) => {
        const person = name(row.memberId);
        return { person, amount: row.amount, sentence: balanceLine(person, row.amount, group.baseCurrency) };
      }),
    );

    // The server sorts its plan by member id, and member ids are random, so its order changes from one sample trip to
    // the next. Sorted by name the way core sorts by id, it must be the story's plan line for line.
    const plan = group.settlement.transfers
      .map((transfer) => ({ from: name(transfer.from), to: name(transfer.to), amount: transfer.amount }))
      .sort(byPayerThenPayee);
    expect(story.payments).toEqual(plan);
    expect(story.proof).toBe(proofLine(group.settlement.transfers.length, group.settlement.expenseCount));
  });

  it("gives the Lisbon trip's known numbers", () => {
    const story = sampleTripStory();

    expect(story.expenses.map((expense) => [expense.id, expense.description])).toEqual([
      ["e1", "Flights"],
      ["e2", "Apartment"],
      ["e3", "Dinner at Taberna"],
      ["e4", "Museum tickets"],
      ["e5", "Taxi from airport"],
      ["e6", "Groceries"],
      ["e7", "Surf lesson"],
    ]);
    expect(story.expenses[6]).toMatchObject({ amount: "150.00", currency: "USD", rate: "0.92", base: "138.00" });
    expect(story.balances).toEqual([
      { person: "Ana", amount: "155.74", sentence: "Ana is owed 155.74 EUR" },
      { person: "Ben", amount: "81.34", sentence: "Ben is owed 81.34 EUR" },
      { person: "Cy", amount: "-95.15", sentence: "Cy owes 95.15 EUR" },
      { person: "Dev", amount: "-141.93", sentence: "Dev owes 141.93 EUR" },
    ]);
    expect(story.payments).toEqual([
      { from: "Cy", to: "Ana", amount: "13.81" },
      { from: "Cy", to: "Ben", amount: "81.34" },
      { from: "Dev", to: "Ana", amount: "141.93" },
    ]);
    expect(story.proof).toBe("3 payments settle 7 expenses.");
  });

  it("is plain data that survives the trip from a server component to the browser", () => {
    const story = sampleTripStory();

    expect(JSON.parse(JSON.stringify(story))).toEqual(story);
  });
});

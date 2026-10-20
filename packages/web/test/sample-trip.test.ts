// Not covered: the home page button in a browser (the "Making your sample trip..." line, sessionStorage and the move
// to /g#token); two real Postgres sessions racing for the last rate-limit place, because PGlite runs a single session;
// Vercel setting its address headers (the tests set them by hand); and Neon.
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/sample-trip/route";
import { type Db, setDbForTests } from "@/db/client";
import { events } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { CreateGroupResponse, GroupView } from "@/lib/api-types";
import { resolveGroup } from "@/lib/groups";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterEach(() => {
  setDbForTests(null);
  vi.useRealTimers();
});

function postSampleTrip(address = "203.0.113.7"): Promise<Response> {
  const headers = { "content-type": "application/json", "x-vercel-forwarded-for": address };
  return POST(new Request("http://localhost/api/sample-trip", { method: "POST", headers }));
}

async function sampleTrip(address?: string): Promise<CreateGroupResponse> {
  const response = await postSampleTrip(address);
  expect(response.status).toBe(201);
  return (await response.json()) as CreateGroupResponse;
}

// Each expense by names instead of ids, sorted by description, so the check does not lean on creation order.
function expensesByName(group: GroupView) {
  const name = new Map(group.members.map((member) => [member.id, member.name]));
  return group.expenses
    .map((expense) => ({
      description: expense.description,
      amount: expense.amount,
      currency: expense.currency,
      rate: expense.rate,
      baseAmount: expense.baseAmount,
      paidBy: name.get(expense.paidBy),
      split: expense.splitMode,
      parts: expense.parts.map((part) => [name.get(part.memberId), part.amount, ...(part.weight === undefined ? [] : [part.weight])]),
    }))
    .sort((a, b) => a.description.localeCompare(b.description));
}

function minor(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}

describe("POST /api/sample-trip", () => {
  it("makes a new Lisbon trip with exactly the listed expenses, whose balances sum to zero", async () => {
    const response = await postSampleTrip();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { token, group } = (await response.json()) as CreateGroupResponse;

    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(group).toMatchObject({ name: "Lisbon trip", baseCurrency: "EUR", baseDigits: 2 });
    expect(group.members.map((member) => member.name)).toEqual(["Ana", "Ben", "Cy", "Dev"]);
    expect(expensesByName(group)).toEqual([
      {
        description: "Apartment",
        amount: "360.00",
        currency: "EUR",
        rate: null,
        baseAmount: "360.00",
        paidBy: "Ben",
        split: "equal",
        parts: [
          ["Ana", "90.00"],
          ["Ben", "90.00"],
          ["Cy", "90.00"],
          ["Dev", "90.00"],
        ],
      },
      {
        description: "Dinner at Taberna",
        amount: "96.50",
        currency: "EUR",
        rate: null,
        baseAmount: "96.50",
        paidBy: "Cy",
        split: "equal",
        parts: [
          ["Ana", "32.17"],
          ["Ben", "32.17"],
          ["Cy", "32.16"],
        ],
      },
      {
        description: "Flights",
        amount: "480.00",
        currency: "EUR",
        rate: null,
        baseAmount: "480.00",
        paidBy: "Ana",
        split: "equal",
        parts: [
          ["Ana", "120.00"],
          ["Ben", "120.00"],
          ["Cy", "120.00"],
          ["Dev", "120.00"],
        ],
      },
      {
        description: "Groceries",
        amount: "42.75",
        currency: "EUR",
        rate: null,
        baseAmount: "42.75",
        paidBy: "Dev",
        split: "equal",
        parts: [
          ["Ana", "10.69"],
          ["Ben", "10.69"],
          ["Cy", "10.69"],
          ["Dev", "10.68"],
        ],
      },
      {
        description: "Museum tickets",
        amount: "54.00",
        currency: "EUR",
        rate: null,
        baseAmount: "54.00",
        paidBy: "Dev",
        split: "exact",
        parts: [
          ["Ana", "18.00"],
          ["Ben", "18.00"],
          ["Dev", "18.00"],
        ],
      },
      {
        description: "Surf lesson",
        amount: "150.00",
        currency: "USD",
        rate: "0.92",
        baseAmount: "138.00",
        paidBy: "Cy",
        split: "equal",
        parts: [
          ["Ana", "75.00"],
          ["Cy", "75.00"],
        ],
      },
      {
        description: "Taxi from airport",
        amount: "31.20",
        currency: "EUR",
        rate: null,
        baseAmount: "31.20",
        paidBy: "Ana",
        split: "shares",
        parts: [
          ["Ana", "15.60", 2],
          ["Ben", "7.80", 1],
          ["Cy", "7.80", 1],
        ],
      },
    ]);

    const name = new Map(group.members.map((member) => [member.id, member.name]));
    expect(group.balances.map((row) => [name.get(row.memberId), row.amount])).toEqual([
      ["Ana", "155.74"],
      ["Ben", "81.34"],
      ["Cy", "-95.15"],
      ["Dev", "-141.93"],
    ]);
    expect(group.balances.reduce((sum, row) => sum + minor(row.amount), BigInt(0))).toBe(BigInt(0));
    expect(group.total).toBe("0.00");
    expect(group.settlement.expenseCount).toBe(7);
  });

  it("writes the same events a person's requests would", async () => {
    const { group } = await sampleTrip();

    const log = await db.select().from(events).where(eq(events.groupId, group.id)).orderBy(asc(events.seq));

    expect(log.map((row) => row.kind)).toEqual([
      "group_created",
      ...Array<string>(4).fill("member_added"),
      ...Array<string>(7).fill("expense_added"),
    ]);
  });

  it("makes a separate group with its own link on every press", async () => {
    const first = await sampleTrip();
    const second = await sampleTrip();

    expect(second.token).not.toBe(first.token);
    expect(second.group.id).not.toBe(first.group.id);
    const ids = (group: GroupView) => [...group.members.map((m) => m.id), ...group.expenses.map((e) => e.id)];
    expect(ids(second.group).filter((id) => ids(first.group).includes(id))).toEqual([]);
    expect((await resolveGroup(db, first.token))?.id).toBe(first.group.id);
    expect((await resolveGroup(db, second.token))?.id).toBe(second.group.id);
  });

  it("answers 429 rate_limited to the 11th sample trip from one network in a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:05.000Z"));
    for (let i = 0; i < 10; i += 1) await sampleTrip("198.51.100.20");

    const limited = await postSampleTrip("198.51.100.20");

    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{"error":{"code":"rate_limited"}}');
    expect((await postSampleTrip("198.51.100.21")).status).toBe(201);
  });
});

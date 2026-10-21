// Not covered: rate limits on group creation (hardening.test.ts holds those), the headers next.config.ts adds,
// response timing, or the Neon driver (this runs on in-memory PGlite).
import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as createGroupRoute } from "@/app/api/groups/route";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups, members } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { hashGroupToken, mintGroupToken } from "@/lib/group-token";
import {
  errorCode,
  expenseBody,
  getGroup,
  groupBody,
  jsonRequest,
  postExpense,
  postGroup,
  readGroup,
  startGroup,
} from "./fixtures";

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

async function rowCounts() {
  const [g] = await db.select({ n: count() }).from(groups);
  const [m] = await db.select({ n: count() }).from(members);
  const [e] = await db.select({ n: count() }).from(events);
  return { groups: g.n, members: m.n, events: e.n };
}

describe("POST /api/groups", () => {
  it("creates the group, its members and their events, and returns the token once", async () => {
    const response = await postGroup(groupBody({ name: "  Lisbon trip  ", members: ["Ana", " Ben ", "Chen"] }));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { token, group } = await response.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(group).toEqual({
      id: expect.any(String),
      name: "Lisbon trip",
      baseCurrency: "EUR",
      baseDigits: 2,
      version: 1,
      baseLocked: false,
      members: [
        { id: expect.any(String), name: "Ana", removable: true },
        { id: expect.any(String), name: "Ben", removable: true },
        { id: expect.any(String), name: "Chen", removable: true },
      ],
      balances: group.members.map((member: { id: string }) => ({ memberId: member.id, amount: "0.00" })),
      total: "0.00",
      settlement: { transfers: [], expenseCount: 0 },
      expenses: [],
      payments: [],
    });

    const [stored] = await db.select().from(groups).where(eq(groups.id, group.id));
    expect(stored.tokenHash).toBe(hashGroupToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    const log = await db.select().from(events).where(eq(events.groupId, group.id)).orderBy(asc(events.seq));
    expect(log.map((row) => row.kind)).toEqual(["group_created", "member_added", "member_added", "member_added"]);
    expect(log.slice(1).map((row) => row.entityId)).toEqual(group.members.map((member: { id: string }) => member.id));
  });

  it("accepts names written with a joiner between two visible characters, and stores them as sent", async () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
    const sinhala = "\u0DC1\u0DCA\u200D\u0DBB\u0DD3";

    const { group } = await startGroup({ name: `${family} trip`, members: [family, persian, sinhala] });

    expect(group.name).toBe(`${family} trip`);
    expect(group.members.map((member) => member.name)).toEqual([family, persian, sinhala]);
  });

  it.each([
    ["a joiner at the start", "\u200DAna"],
    ["a non-joiner at the end", "Ana\u200C"],
    ["a joiner on its own", "\u200D"],
    ["two joiners in a row", "A\u200D\u200Dna"],
    ["a joiner next to a space", "Ana \u200DBen"],
    ["a right-to-left mark", "Ana\u200F"],
    ["a zero-width space", "A\u200Bna"],
    ["a soft hyphen", "A\u00ADna"],
  ])("refuses a member name with %s as bad_member_name", async (_label, name) => {
    const response = await postGroup(groupBody({ members: ["Ben", name] }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_member_name");
  });

  it("accepts names at their exact limits, counting an emoji as one character", async () => {
    const { group } = await startGroup({ name: "g".repeat(60), members: ["m".repeat(40), "\u{1F600}".repeat(40)] });

    expect(group.name).toHaveLength(60);
    expect(group.members.map((member) => [...member.name].length)).toEqual([40, 40]);
  });

  it.each([
    ["an unknown field", { ...groupBody(), token: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a missing field", { name: "Trip", members: ["Ana", "Ben"] }],
    ["a number for the name", { ...groupBody(), name: 7 }],
    ["a string for members", { ...groupBody(), members: "Ana,Ben" }],
    ["an array body", [groupBody()]],
    ["broken JSON", '{"name": "Trip",'],
    ["an empty body", ""],
    ["a body over 16 KB", { ...groupBody(), name: "x".repeat(17 * 1024) }],
  ])("refuses %s with invalid_body", async (_label, body) => {
    const response = await postGroup(body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_body");
  });

  it("refuses a body that claims more than 16 KB before reading it", async () => {
    const request = jsonRequest("/api/groups", groupBody());
    const oversized = new Request(request, {
      headers: { "content-type": "application/json", "content-length": String(16 * 1024 + 1) },
    });

    expect(await errorCode(await createGroupRoute(oversized))).toBe("invalid_body");
  });

  it.each([
    ["bad_name", "an empty name", groupBody({ name: "   " })],
    ["bad_name", "a 61 character name", groupBody({ name: "g".repeat(61) })],
    ["bad_name", "a right-to-left override", groupBody({ name: "Trip‮gnp.exe" })],
    ["bad_name", "a zero-width space", groupBody({ name: "Tr​ip" })],
    ["bad_name", "a control character", groupBody({ name: "Trip\u0007" })],
    ["bad_currency", "a lower-case code", groupBody({ baseCurrency: "eur" })],
    ["bad_currency", "a code with no minor unit", groupBody({ baseCurrency: "XAU" })],
    ["bad_currency", "an unknown code", groupBody({ baseCurrency: "ZZZ" })],
    ["bad_currency", "a four letter code", groupBody({ baseCurrency: "EURO" })],
    ["too_few_members", "one member", groupBody({ members: ["Ana"] })],
    ["too_few_members", "no members", groupBody({ members: [] })],
    ["too_many_members", "21 members", groupBody({ members: Array.from({ length: 21 }, (_, i) => `Member ${i}`) })],
    ["bad_member_name", "an empty member name", groupBody({ members: ["Ana", " "] })],
    ["bad_member_name", "a 41 character member name", groupBody({ members: ["Ana", "m".repeat(41)] })],
    ["bad_member_name", "a member name that starts with a zero-width joiner", groupBody({ members: ["Ana", "\u200DBen"] })],
    ["duplicate_member_name", "names that differ only in case", groupBody({ members: ["Ana", "ANA"] })],
    ["duplicate_member_name", "composed and decomposed accents", groupBody({ members: ["José", "José"] })],
  ])("answers %s for %s and writes nothing", async (code, _label, body) => {
    const before = await rowCounts();

    const response = await postGroup(body);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ error: { code } }));
    expect(await rowCounts()).toEqual(before);
  });
});

describe("GET /api/group", () => {
  it("returns the same view the creation returned, and writes nothing", async () => {
    const { token, group } = await startGroup();
    const before = await rowCounts();

    const response = await getGroup(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(group);
    expect(await rowCounts()).toEqual(before);
  });

  it("gives byte-identical 404s for a malformed, an unknown and a missing token", async () => {
    await startGroup();
    const answers = await Promise.all(
      ["not a token", mintGroupToken().token, null].map(async (token) => {
        const response = await getGroup(token);
        return { status: response.status, headers: [...response.headers], body: await response.text() };
      }),
    );

    expect(answers[0]).toEqual({
      status: 404,
      headers: expect.any(Array),
      body: '{"error":{"code":"not_found"}}',
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it.each([
    ["EUR", "0.00", 2],
    ["JPY", "0", 0],
    ["KWD", "0.000", 3],
  ])("shows a %s total of %s with %i decimals", async (baseCurrency, total, digits) => {
    const { token } = await startGroup({ baseCurrency });

    const view = await readGroup(token);

    expect(view.total).toBe(total);
    expect(view.baseDigits).toBe(digits);
    expect(view.balances.map((row) => row.amount)).toEqual([total, total, total]);
  });
});

describe("an unexpected failure", () => {
  it("answers every handler with the bare 500 and none of the error's text", async () => {
    const { group } = await startGroup();
    const token = mintGroupToken().token;
    const broken = new Proxy({} as Db, {
      get() {
        throw new Error("connect ECONNREFUSED postgres://penny:hunter2@db.internal:5432/penny");
      },
    });
    setDbForTests(broken);
    try {
      const answers = await Promise.all([
        postGroup(groupBody()),
        getGroup(token),
        postExpense(token, expenseBody(group)),
      ]);
      for (const response of answers) {
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('{"error":{"code":"internal"}}');
      }
    } finally {
      setDbForTests(db);
    }
  });
});

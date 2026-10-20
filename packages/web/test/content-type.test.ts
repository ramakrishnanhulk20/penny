// Not covered: a real browser's CORS check (only that every write needs a header another site cannot send without
// asking first); Next.js handing every POST, PATCH and DELETE a body stream even when none was sent (read in its
// next-request adapter, played here by an empty body); and the GET routes, whose bodies Next.js drops.
import { count } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DELETE as deleteExpenseRoute, PATCH as editExpenseRoute } from "@/app/api/group/expenses/[expenseId]/route";
import { POST as addExpenseRoute } from "@/app/api/group/expenses/route";
import { DELETE as removeMemberRoute } from "@/app/api/group/members/[memberId]/route";
import { POST as addMemberRoute } from "@/app/api/group/members/route";
import { DELETE as undoPaymentRoute } from "@/app/api/group/payments/[paymentId]/route";
import { POST as addPaymentRoute } from "@/app/api/group/payments/route";
import { POST as resetLinkRoute } from "@/app/api/group/reset-link/route";
import { PATCH as changeGroupRoute } from "@/app/api/group/route";
import { POST as createGroupRoute } from "@/app/api/groups/route";
import { POST as sampleTripRoute } from "@/app/api/sample-trip/route";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups, rateLimits } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import * as client from "@/lib/client/api";
import { lookUpRate } from "@/lib/client/fx";
import { startSampleTrip } from "@/lib/client/sample-trip";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { freshAddress, groupBody, startGroup } from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const UNSUPPORTED = '{"error":{"code":"unsupported_media_type"}}';
const SOME_ID = "00000000-0000-4000-8000-000000000000";

let db: Db;
let token: string;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  ({ token } = await startGroup());
});

afterAll(() => {
  setDbForTests(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

// Every route that takes a POST, PATCH or DELETE, by method and path.
const WRITES: [string, string, (request: Request) => Promise<Response>][] = [
  ["POST", "/api/groups", (r) => createGroupRoute(r)],
  ["POST", "/api/sample-trip", (r) => sampleTripRoute(r)],
  ["PATCH", "/api/group", (r) => changeGroupRoute(r)],
  ["POST", "/api/group/expenses", (r) => addExpenseRoute(r)],
  ["PATCH", `/api/group/expenses/${SOME_ID}`, (r) => editExpenseRoute(r, params({ expenseId: SOME_ID }))],
  ["DELETE", `/api/group/expenses/${SOME_ID}?version=1`, (r) => deleteExpenseRoute(r, params({ expenseId: SOME_ID }))],
  ["POST", "/api/group/members", (r) => addMemberRoute(r)],
  ["DELETE", `/api/group/members/${SOME_ID}`, (r) => removeMemberRoute(r, params({ memberId: SOME_ID }))],
  ["POST", "/api/group/payments", (r) => addPaymentRoute(r)],
  ["DELETE", `/api/group/payments/${SOME_ID}`, (r) => undoPaymentRoute(r, params({ paymentId: SOME_ID }))],
  ["POST", "/api/group/reset-link", (r) => resetLinkRoute(r)],
];

// What another site can make a browser send without a CORS check, plus spellings that only look like JSON.
const NOT_JSON: [string, string | null][] = [
  ["text/plain", "text/plain;charset=UTF-8"],
  ["a form", "application/x-www-form-urlencoded"],
  ["a multipart form", "multipart/form-data; boundary=penny"],
  ["no type at all", null],
  ["two types joined by a comma", "application/json, text/plain"],
  ["a type that only starts like JSON", "application/jsonp"],
];

function request(method: string, path: string, type: string | null, body: BodyInit | null): Request {
  const headers = new Headers({ "x-vercel-forwarded-for": freshAddress(), [GROUP_TOKEN_HEADER]: token });
  if (type !== null) headers.set("content-type", type);
  return new Request(`http://localhost${path}`, { method, headers, body });
}

async function writesSoFar(): Promise<number[]> {
  const counted = await Promise.all([groups, events, rateLimits].map((table) => db.select({ n: count() }).from(table)));
  return counted.map(([row]) => row.n);
}

describe("bodies that are not declared JSON", () => {
  const cases = WRITES.flatMap(([method, path, send]) =>
    NOT_JSON.map(([label, type]) => [`${method} ${path.split("?")[0]}`, label, method, path, type, send] as const),
  );

  it.each(cases)("%s answers 415 to %s before touching the database", async (_route, _label, method, path, type, send) => {
    const before = await writesSoFar();
    // A JSON text, so only the declared type can be what refuses it. Bytes, so no type is added for it.
    const body = new TextEncoder().encode(JSON.stringify({ name: "Ana" }));

    const response = await send(request(method, path, type, body));

    expect(response.status).toBe(415);
    expect(await response.text()).toBe(UNSUPPORTED);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await writesSoFar()).toEqual(before);
  });

  it.each(WRITES)("%s %s answers 415 to an empty body with no type, as Next.js passes a bodiless write", async (method, path, send) => {
    const response = await send(request(method, path, null, new Uint8Array(0)));

    expect([response.status, await response.text()]).toEqual([415, UNSUPPORTED]);
  });

  it.each(WRITES)("%s %s lets an empty body declared JSON through to its own checks", async (method, path, send) => {
    const response = await send(request(method, path, "application/json", new Uint8Array(0)));

    expect(response.status).not.toBe(415);
  });

  it("takes JSON with a charset and in any letter case", async () => {
    const response = await createGroupRoute(
      request("POST", "/api/groups", "Application/JSON; charset=utf-8", JSON.stringify(groupBody())),
    );

    expect(response.status).toBe(201);
  });

  it("makes a sample trip only when the request declares JSON, though it sends no body", async () => {
    const before = await writesSoFar();
    const bare = new Request("http://localhost/api/sample-trip", {
      method: "POST",
      headers: { "x-vercel-forwarded-for": freshAddress() },
    });

    const refused = await sampleTripRoute(bare);

    expect([refused.status, await refused.text()]).toEqual([415, UNSUPPORTED]);
    expect(await writesSoFar()).toEqual(before);
    expect((await sampleTripRoute(request("POST", "/api/sample-trip", "application/json", null))).status).toBe(201);
  });
});

describe("the browser's calls", () => {
  it("declare JSON on every request, with a body or without one", async () => {
    const sent: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(new URL(String(input), "http://localhost"), init));
      return new Response('{"error":{"code":"internal"}}', { status: 500 });
    });
    const transfer = { from: SOME_ID, to: SOME_ID, amount: "1.00" };
    const calls: Record<string, () => Promise<unknown>> = {
      createGroup: () => client.createGroup(groupBody()),
      getGroup: () => client.getGroup(token),
      addExpense: () =>
        client.addExpense(token, {
          clientId: "client-id-1",
          description: "Dinner",
          amount: "1.00",
          currency: "EUR",
          rate: null,
          paidBy: SOME_ID,
          split: { mode: "equal", members: [SOME_ID] },
        }),
      editExpense: () =>
        client.editExpense(token, SOME_ID, {
          version: 1,
          description: "Dinner",
          amount: "1.00",
          currency: "EUR",
          rate: null,
          paidBy: SOME_ID,
          split: { mode: "equal", members: [SOME_ID] },
        }),
      deleteExpense: () => client.deleteExpense(token, SOME_ID, 1),
      addPayment: () =>
        client.addPayment(token, { clientId: "client-id-2", planVersion: 1, ...transfer, currency: "EUR", rate: null }),
      undoPayment: () => client.undoPayment(token, SOME_ID),
      addMember: () => client.addMember(token, { name: "Dev" }),
      removeMember: () => client.removeMember(token, SOME_ID),
      changeBaseCurrency: () => client.changeBaseCurrency(token, { baseCurrency: "USD" }),
      resetLink: () => client.resetLink(token, client.newLinkToken()),
    };
    // Every function the module exports either calls the API and is listed above, or makes a value without a request.
    expect(Object.keys(client).sort()).toEqual([...Object.keys(calls), "newLinkToken", "settleClientId"].sort());

    for (const call of Object.values(calls)) await call();
    await lookUpRate("USD", "EUR");
    await startSampleTrip();

    expect(sent).toHaveLength(Object.keys(calls).length + 2);
    for (const request of sent) {
      expect([request.method, new URL(request.url).pathname, request.headers.get("content-type")]).toEqual([
        request.method,
        new URL(request.url).pathname,
        "application/json",
      ]);
    }
  });
});

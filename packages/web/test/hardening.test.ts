// Not covered: Vercel setting the address headers (the tests set them by hand); two real Postgres sessions racing for
// the last place under a limit, because PGlite runs a single session; Neon itself, where the triggers and the token
// hash check run on the same Postgres rules PGlite runs here; a role that owns the events table dropping the triggers
// (a named non-goal in the threat model); and what a browser does with the security headers, since only the header
// strings are checked, not a page loading under them or the Vercel toolbar working on a preview.
import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { GET as checksRoute } from "@/app/api/checks/route";
import { GET as fxRoute } from "@/app/api/fx/route";
import { DELETE as deleteExpenseRoute, PATCH as editExpenseRoute } from "@/app/api/group/expenses/[expenseId]/route";
import { POST as addExpenseRoute } from "@/app/api/group/expenses/route";
import { DELETE as removeMemberRoute } from "@/app/api/group/members/[memberId]/route";
import { POST as addMemberRoute } from "@/app/api/group/members/route";
import { DELETE as undoPaymentRoute } from "@/app/api/group/payments/[paymentId]/route";
import { POST as addPaymentRoute } from "@/app/api/group/payments/route";
import { POST as resetLinkRoute } from "@/app/api/group/reset-link/route";
import { GET as getGroupRoute, PATCH as changeGroupRoute } from "@/app/api/group/route";
import { POST as createGroupRoute } from "@/app/api/groups/route";
import { POST as sampleTripRoute } from "@/app/api/sample-trip/route";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups, rateLimits, serverKeys } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { GroupView } from "@/lib/api-types";
import { GROUP_TOKEN_HEADER, hashGroupToken, mintGroupToken } from "@/lib/group-token";
import { LIMITS, type Limit, clientNetwork, networkKey } from "@/lib/rate-limit";
import { editBody, expenseBody, freshAddress, paymentBody, startGroup } from "./fixtures";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

// The docs source uses the fumadocs-mdx macro, which needs that package's bundler plugin, and vitest does not run it.
// The search route is imported here only for its time limit, and createFromSource reads the source only when a search
// runs, so an empty stand-in is enough.
vi.mock("@/lib/source", () => ({ source: {} }));

const T0 = new Date("2026-10-19T12:00:05.000Z");
const SOME_ID = "00000000-0000-4000-8000-000000000000";
const RATE_LIMITED = '{"error":{"code":"rate_limited"}}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  // /api/checks must never reach GitHub from a test; with no stored read this makes it answer 503.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Send = { method?: string; token?: string; body?: unknown };

function request(path: string, address: string, { method = "GET", token, body }: Send = {}): Request {
  const headers = new Headers({ "x-vercel-forwarded-for": address });
  if (token !== undefined) headers.set(GROUP_TOKEN_HEADER, token);
  // As the browser's calls do: every write declares JSON, with a body or without one.
  if (body !== undefined || method !== "GET") headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

function keyFor(address: string): Promise<string> {
  return networkKey(db, clientNetwork(new Headers({ "x-vercel-forwarded-for": address })));
}

// Puts `used` requests on the key's count in the current window, as if they had just been made.
async function fill(limit: Limit, key: string, used: number): Promise<void> {
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  await db.insert(rateLimits).values({ bucket: limit.bucket, key, windowStart, count: used });
}

// Drizzle wraps the driver error; the Postgres message and constraint name sit on its cause.
async function refusal(query: PromiseLike<unknown>): Promise<{ message?: string; constraint?: string }> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: unknown }).cause ?? error) as { message?: string; constraint?: string };
  }
  throw new Error("expected the database to refuse this statement");
}

// Every limited route, the limit it counts against per client network, and a request it answers with anything but
// 429 while under that limit. The limit is taken before any of the request is read, so the request need not be valid.
const BY_NETWORK: [string, Limit, (address: string) => Promise<Response>][] = [
  ["POST /api/groups", LIMITS.createGroup, (a) => createGroupRoute(request("/api/groups", a, { method: "POST", body: {} }))],
  ["POST /api/sample-trip", LIMITS.sampleTrip, (a) => sampleTripRoute(request("/api/sample-trip", a, { method: "POST" }))],
  ["GET /api/fx", LIMITS.fx, (a) => fxRoute(request("/api/fx", a))],
  ["GET /api/checks", LIMITS.groupRead, (a) => checksRoute(request("/api/checks", a))],
  ["GET /api/group", LIMITS.groupRead, (a) => getGroupRoute(request("/api/group", a))],
  [
    "PATCH /api/group",
    LIMITS.groupWritePerNetwork,
    (a) => changeGroupRoute(request("/api/group", a, { method: "PATCH", body: {} })),
  ],
  [
    "POST /api/group/expenses",
    LIMITS.groupWritePerNetwork,
    (a) => addExpenseRoute(request("/api/group/expenses", a, { method: "POST", body: {} })),
  ],
  [
    "PATCH /api/group/expenses/{id}",
    LIMITS.groupWritePerNetwork,
    (a) => editExpenseRoute(request(`/api/group/expenses/${SOME_ID}`, a, { method: "PATCH", body: {} }), params({ expenseId: SOME_ID })),
  ],
  [
    "DELETE /api/group/expenses/{id}",
    LIMITS.groupWritePerNetwork,
    (a) => deleteExpenseRoute(request(`/api/group/expenses/${SOME_ID}?version=1`, a, { method: "DELETE" }), params({ expenseId: SOME_ID })),
  ],
  [
    "POST /api/group/members",
    LIMITS.groupWritePerNetwork,
    (a) => addMemberRoute(request("/api/group/members", a, { method: "POST", body: {} })),
  ],
  [
    "DELETE /api/group/members/{id}",
    LIMITS.groupWritePerNetwork,
    (a) => removeMemberRoute(request(`/api/group/members/${SOME_ID}`, a, { method: "DELETE" }), params({ memberId: SOME_ID })),
  ],
  [
    "POST /api/group/payments",
    LIMITS.groupWritePerNetwork,
    (a) => addPaymentRoute(request("/api/group/payments", a, { method: "POST", body: {} })),
  ],
  [
    "DELETE /api/group/payments/{id}",
    LIMITS.groupWritePerNetwork,
    (a) => undoPaymentRoute(request(`/api/group/payments/${SOME_ID}`, a, { method: "DELETE" }), params({ paymentId: SOME_ID })),
  ],
  [
    "POST /api/group/reset-link",
    LIMITS.groupWritePerNetwork,
    (a) => resetLinkRoute(request("/api/group/reset-link", a, { method: "POST", body: {} })),
  ],
];

// Every group write route, with a request that passes every check in front of the per-group limit. Each call comes
// from a new address, so only the group's own count can refuse it.
const BY_GROUP: [string, (token: string, group: GroupView) => Promise<Response>][] = [
  [
    "PATCH /api/group",
    (t, g) => changeGroupRoute(request("/api/group", freshAddress(), { method: "PATCH", token: t, body: { baseCurrency: g.baseCurrency } })),
  ],
  [
    "POST /api/group/expenses",
    (t, g) => addExpenseRoute(request("/api/group/expenses", freshAddress(), { method: "POST", token: t, body: expenseBody(g) })),
  ],
  [
    "PATCH /api/group/expenses/{id}",
    (t, g) =>
      editExpenseRoute(
        request(`/api/group/expenses/${SOME_ID}`, freshAddress(), { method: "PATCH", token: t, body: editBody(g, 1) }),
        params({ expenseId: SOME_ID }),
      ),
  ],
  [
    "DELETE /api/group/expenses/{id}",
    (t) =>
      deleteExpenseRoute(
        request(`/api/group/expenses/${SOME_ID}?version=1`, freshAddress(), { method: "DELETE", token: t }),
        params({ expenseId: SOME_ID }),
      ),
  ],
  [
    "POST /api/group/members",
    (t) => addMemberRoute(request("/api/group/members", freshAddress(), { method: "POST", token: t, body: { name: "Zed" } })),
  ],
  [
    "DELETE /api/group/members/{id}",
    (t) =>
      removeMemberRoute(
        request(`/api/group/members/${SOME_ID}`, freshAddress(), { method: "DELETE", token: t }),
        params({ memberId: SOME_ID }),
      ),
  ],
  [
    "POST /api/group/payments",
    (t, g) => addPaymentRoute(request("/api/group/payments", freshAddress(), { method: "POST", token: t, body: paymentBody(g) })),
  ],
  [
    "DELETE /api/group/payments/{id}",
    (t) =>
      undoPaymentRoute(
        request(`/api/group/payments/${SOME_ID}`, freshAddress(), { method: "DELETE", token: t }),
        params({ paymentId: SOME_ID }),
      ),
  ],
  [
    "POST /api/group/reset-link",
    (t) => resetLinkRoute(request("/api/group/reset-link", freshAddress(), { method: "POST", token: t, body: {} })),
  ],
];

describe("rate limits on every route", () => {
  it.each(BY_NETWORK)("%s allows its limit from one network, then answers 429 with Retry-After", async (_name, limit, send) => {
    const address = freshAddress();
    await fill(limit, await keyFor(address), limit.limit - 1);

    expect((await send(address)).status).not.toBe(429);
    const refused = await send(address);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(await refused.text()).toBe(RATE_LIMITED);
    expect((await send(freshAddress())).status).not.toBe(429);
  });

  it.each(BY_GROUP)("%s allows its limit for one group from any network, then answers 429 with Retry-After", async (_name, send) => {
    const { token, group } = await startGroup();
    await fill(LIMITS.groupWritePerGroup, group.id, LIMITS.groupWritePerGroup.limit - 1);

    const allowed = await send(token, group);
    expect(allowed.status).not.toBe(429);
    // Reset link hands back a new token and retires the old one, so the next call has to use it.
    const reply = (await allowed.json()) as { token?: unknown };
    const current = typeof reply.token === "string" ? reply.token : token;
    const refused = await send(current, group);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(await refused.text()).toBe(RATE_LIMITED);
  });

  it.each(BY_GROUP)("%s answers an unknown token 404, never 429, while a group is past its limit", async (_name, send) => {
    const { token, group } = await startGroup();
    await fill(LIMITS.groupWritePerGroup, group.id, 10 * LIMITS.groupWritePerGroup.limit);

    const unknown = await send(mintGroupToken().token, group);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('{"error":{"code":"not_found"}}');
    expect((await send(token, group)).status).toBe(429);
  });

  it("allows 240 reads of one group a minute from any network, then answers 429, and an unknown token still gets 404", async () => {
    const { token, group } = await startGroup();
    const read = (current: string) => getGroupRoute(request("/api/group", freshAddress(), { token: current }));
    await fill(LIMITS.groupReadPerGroup, group.id, LIMITS.groupReadPerGroup.limit - 1);

    expect((await read(token)).status).toBe(200);
    const refused = await read(token);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.text()).toBe(RATE_LIMITED);
    expect((await read(mintGroupToken().token)).status).toBe(404);
    expect((await read((await startGroup()).token)).status).toBe(200);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    expect((await read(token)).status).toBe(200);
  });

  it("stores no raw address: every network key is the HMAC under the server key, every group key a group id", async () => {
    const addresses = ["203.0.113.7", "2001:db8:aa:bb::1"];
    const { token, group } = await startGroup();
    for (const address of addresses) {
      for (const [, , send] of BY_NETWORK) await send(address);
      await addMemberRoute(request("/api/group/members", address, { method: "POST", token, body: { name: `M${address.length}` } }));
    }

    const [server] = await db.select().from(serverKeys);
    const hashed = addresses.map((address) =>
      createHmac("sha256", server.hmacKey)
        .update(clientNetwork(new Headers({ "x-vercel-forwarded-for": address })))
        .digest("hex"),
    );
    const rows = await db.select().from(rateLimits);
    for (const bucket of new Set(BY_NETWORK.map(([, limit]) => limit.bucket))) {
      for (const key of hashed) expect(rows).toContainEqual(expect.objectContaining({ bucket, key }));
    }
    expect(rows).toContainEqual(expect.objectContaining({ bucket: LIMITS.groupWritePerGroup.bucket, key: group.id }));
    for (const row of rows) {
      const perGroup = [LIMITS.groupWritePerGroup.bucket, LIMITS.groupReadPerGroup.bucket].includes(row.bucket);
      expect(row.key).toMatch(perGroup ? UUID : /^[0-9a-f]{64}$/);
      for (const raw of [...addresses, "ip4:", "ip6:", "unknown"]) expect(row.key).not.toContain(raw);
    }
  });
});

describe("time limits", () => {
  it("sets maxDuration to 10 seconds in every route file under src/app/api", async () => {
    const api = join(__dirname, "..", "src", "app", "api");
    const files = readdirSync(api, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith("route.ts"));
    expect(files.length).toBeGreaterThanOrEqual(13);

    for (const file of files) {
      const route = (await import(pathToFileURL(join(api, file)).href)) as { maxDuration?: unknown };
      expect([file, route.maxDuration]).toEqual([file, 10]);
    }
  });
});

describe("the events table", () => {
  it.each([
    ["UPDATE", () => db.execute(sql`update events set kind = kind`)],
    ["DELETE", () => db.delete(events)],
    ["TRUNCATE", () => db.execute(sql`truncate events`)],
    ["deleting a group that has events, through the cascade", () => db.delete(groups)],
  ])("refuses %s, and every event stays", async (_name, run) => {
    await startGroup();
    const before = await db.select({ n: count() }).from(events);
    expect(before[0].n).toBeGreaterThan(0);

    expect((await refusal(run())).message).toBe("events are append-only");
    expect(await db.select({ n: count() }).from(events)).toEqual(before);
  });
});

describe("groups.token_hash", () => {
  it.each([
    ["an empty string", ""],
    ["63 hex characters", "a".repeat(63)],
    ["65 hex characters", "a".repeat(65)],
    ["upper-case hex", "A".repeat(64)],
    ["64 characters that are not hex", "g".repeat(64)],
    ["64 hex characters and a newline", `${"a".repeat(64)}\n`],
    ["the raw token instead of its hash", mintGroupToken().token],
  ])("refuses %s", async (_label, tokenHash) => {
    const refused = await refusal(db.insert(groups).values({ tokenHash, name: "Flat 4B", baseCurrency: "EUR" }));
    expect(refused.constraint).toBe("groups_token_hash_format");
  });

  it("accepts the sha256 hex hashGroupToken writes", async () => {
    const tokenHash = hashGroupToken(mintGroupToken().token);
    await db.insert(groups).values({ tokenHash, name: "Flat 4B", baseCurrency: "EUR" });
    expect(await db.select({ n: count() }).from(groups).where(eq(groups.tokenHash, tokenHash))).toEqual([{ n: 1 }]);
  });
});

describe("security headers", () => {
  const PRODUCTION =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
  const PREVIEW =
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://vercel.live; " +
    "style-src 'self' 'unsafe-inline' https://vercel.live; img-src 'self' data: https://vercel.live https://vercel.com blob:; " +
    "font-src 'self' https://vercel.live https://assets.vercel.com; connect-src 'self' https://vercel.live wss://ws-us3.pusher.com; " +
    "frame-src 'self' https://vercel.live; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
  const DEVELOPMENT = PRODUCTION.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'");

  it.each([
    ["a production build", "production", "production", PRODUCTION],
    ["a build outside Vercel", "production", "", PRODUCTION],
    ["a preview build", "production", "preview", PREVIEW],
    ["next dev", "development", "", DEVELOPMENT],
  ])("sends exactly the agreed policy and HSTS on every route for %s", async (_label, nodeEnv, vercelEnv, policy) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("VERCEL_ENV", vercelEnv);

    const rules = (await nextConfig.headers?.()) ?? [];
    const everyRoute = rules.find((rule) => rule.source === "/:path*");
    const headers = new Map(everyRoute?.headers.map((header) => [header.key, header.value]));
    expect(headers.get("Content-Security-Policy")).toBe(policy);
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });
});

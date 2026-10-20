// Not covered: a real Neon connection, that Next serves this route at request time (the build route table shows that),
// or two instances, each of which keeps its own 10 s window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { createTestDb } from "@/db/testing";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

const T0 = new Date("2026-10-20T12:00:00.000Z");

// A copy of the route with no check remembered, as a newly started instance would load it, and the setDbForTests of
// that same copy's database module.
async function freshRoute(db: Db) {
  vi.resetModules();
  const client = await import("@/db/client");
  client.setDbForTests(db);
  const { GET } = await import("@/app/api/health/route");
  return { GET, setDb: client.setDbForTests };
}

// The real test database, counting every query the route sends it.
async function countingDb(): Promise<{ db: Db; queries: () => number }> {
  const real = await createTestDb();
  let sent = 0;
  const db = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "execute") return Reflect.get(target, property, receiver);
      return (...args: Parameters<Db["execute"]>) => {
        sent += 1;
        return target.execute(...args);
      };
    },
  });
  return { db, queries: () => sent };
}

const broken = {
  execute: () => Promise.reject(new Error("connect ECONNREFUSED postgres://penny:hunter2@db.internal:5432/penny")),
} as unknown as Db;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/health", () => {
  it('returns 200 {"status":"up"} when the database answers', async () => {
    const { GET } = await freshRoute(await createTestDb());

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"up"}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it('returns 503 {"status":"down"} and nothing else when the query throws', async () => {
    const { GET } = await freshRoute(broken);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"down"}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("asks the database once per 10 s on an instance, however many calls arrive, together or apart", async () => {
    const { db, queries } = await countingDb();
    const { GET } = await freshRoute(db);

    const together = await Promise.all(Array.from({ length: 5 }, () => GET()));
    expect(together.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    vi.setSystemTime(new Date(T0.getTime() + 9_999));
    expect((await GET()).status).toBe(200);
    expect(queries()).toBe(1);

    vi.setSystemTime(new Date(T0.getTime() + 10_000));
    expect((await GET()).status).toBe(200);
    expect(queries()).toBe(2);
  });

  it("keeps a down answer for 10 s too, then checks again, and treats a check from the future as expired", async () => {
    const { GET, setDb } = await freshRoute(broken);
    expect((await GET()).status).toBe(503);

    setDb(await createTestDb());
    vi.setSystemTime(new Date(T0.getTime() + 5_000));
    expect((await GET()).status).toBe(503);
    vi.setSystemTime(new Date(T0.getTime() + 10_000));
    expect((await GET()).status).toBe(200);

    setDb(broken);
    vi.setSystemTime(T0);
    expect((await GET()).status).toBe(503);
  });
});

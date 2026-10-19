// Not covered: two real Postgres sessions racing on one rate_limits row, or two instances inserting the first server
// key at the same moment, because PGlite runs a single session (the second instance is played by a fresh copy of the
// module finding a key already stored); the once-a-minute sweep pacing across instances, since each instance keeps its
// own clock; Vercel setting its address headers (the tests set them by hand); and Neon itself. The routes' use of
// these limits is in hardening.test.ts.
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { rateLimits, serverKeys } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { LIMITS, type Limit, clientNetwork, takeRateLimit, tooMany } from "@/lib/rate-limit";

const T0 = new Date("2026-10-19T12:00:05.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// A copy of the module with nothing cached, as a newly started instance would load it.
async function freshInstance(): Promise<typeof import("@/lib/rate-limit")> {
  vi.resetModules();
  return import("@/lib/rate-limit");
}

async function storedKey(db: Db): Promise<Uint8Array[]> {
  const rows = await db.select({ hmacKey: serverKeys.hmacKey }).from(serverKeys);
  return rows.map((row) => row.hmacKey);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clientNetwork", () => {
  it.each([
    [{ "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.1" }, "ip4:203.0.113.7"],
    [{ "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1" }, "ip4:203.0.113.7"],
    [{ "x-real-ip": "198.51.100.1" }, "ip4:198.51.100.1"],
    [{ "x-vercel-forwarded-for": "2001:db8:aa:bb:1:2:3:4" }, "ip6:2001:db8:aa:bb::/64"],
    [{ "x-vercel-forwarded-for": "2001:DB8:AA:BB::9" }, "ip6:2001:db8:aa:bb::/64"],
    [{ "x-vercel-forwarded-for": "2001:db8::1" }, "ip6:2001:db8:0:0::/64"],
    [{ "x-vercel-forwarded-for": "::ffff:203.0.113.7" }, "ip4:203.0.113.7"],
    [{ "x-forwarded-for": "203.0.113.7" }, "unknown"],
    [{ "x-vercel-forwarded-for": "not an address", "x-real-ip": "198.51.100.1" }, "unknown"],
    [{ "x-vercel-forwarded-for": "01.2.3.4" }, "unknown"],
    [{}, "unknown"],
  ])("reads %j as %s", (headers, network) => {
    expect(clientNetwork(new Headers(headers))).toBe(network);
  });
});

describe("takeRateLimit", () => {
  it("allows exactly the limit in a window, refuses the next, and starts again in the next window", async () => {
    const db = await createTestDb();
    const key = "a".repeat(64);

    for (let i = 0; i < LIMITS.fx.limit; i += 1) expect(await takeRateLimit(db, LIMITS.fx, key)).toBe(true);
    expect(await takeRateLimit(db, LIMITS.fx, key)).toBe(false);
    expect(await takeRateLimit(db, LIMITS.fx, "b".repeat(64))).toBe(true);
    expect(await takeRateLimit(db, LIMITS.sampleTrip, key)).toBe(true);

    vi.setSystemTime(new Date("2026-10-19T12:01:00.000Z"));
    expect(await takeRateLimit(db, LIMITS.fx, key)).toBe(true);
    const rows = await db
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.bucket, LIMITS.fx.bucket), eq(rateLimits.key, key)));
    expect(rows).toEqual([
      { bucket: LIMITS.fx.bucket, key, windowStart: new Date("2026-10-19T12:01:00.000Z"), count: 1 },
    ]);
  });

  it("refuses settings that are not positive whole numbers, and an empty bucket or key", async () => {
    const db = await createTestDb();
    await expect(takeRateLimit(db, { bucket: "fx", limit: 0, windowSeconds: 60 }, "k")).rejects.toThrow();
    await expect(takeRateLimit(db, { bucket: "fx", limit: 60, windowSeconds: 0.5 }, "k")).rejects.toThrow();
    await expect(takeRateLimit(db, { bucket: "", limit: 60, windowSeconds: 60 }, "k")).rejects.toThrow();
    await expect(takeRateLimit(db, LIMITS.fx, "")).rejects.toThrow();
    expect(await db.select().from(rateLimits)).toEqual([]);
  });

  it("deletes the bucket's windows older than a day, at most once a minute, and leaves other buckets alone", async () => {
    const db = await createTestDb();
    const sweep: Limit = { bucket: "sweep-test", limit: 5, windowSeconds: 60 };
    const other: Limit = { bucket: "sweep-other", limit: 5, windowSeconds: 60 };
    const old = (offsetMs: number) => new Date(T0.getTime() - offsetMs);
    await db.insert(rateLimits).values([
      { bucket: sweep.bucket, key: "old", windowStart: old(DAY_MS + 1000), count: 3 },
      { bucket: sweep.bucket, key: "recent", windowStart: old(DAY_MS - 60_000), count: 3 },
      { bucket: other.bucket, key: "old", windowStart: old(DAY_MS + 1000), count: 3 },
    ]);

    await takeRateLimit(db, sweep, "caller");
    const keysIn = async (bucket: string) =>
      (await db.select({ key: rateLimits.key }).from(rateLimits).where(eq(rateLimits.bucket, bucket)))
        .map((row) => row.key)
        .sort();
    expect(await keysIn(sweep.bucket)).toEqual(["caller", "recent"]);
    expect(await keysIn(other.bucket)).toEqual(["old"]);

    await db.insert(rateLimits).values({ bucket: sweep.bucket, key: "later", windowStart: old(2 * DAY_MS), count: 1 });
    vi.setSystemTime(new Date(T0.getTime() + 59_000));
    await takeRateLimit(db, sweep, "caller");
    expect(await keysIn(sweep.bucket)).toEqual(["caller", "later", "recent"]);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await takeRateLimit(db, sweep, "caller");
    expect(await keysIn(sweep.bucket)).toEqual(["caller", "recent"]);
  });
});

describe("networkKey", () => {
  it("creates one 32-byte server key, hashes each network with it, and keeps using it on this instance", async () => {
    const db = await createTestDb();
    const instance = await freshInstance();

    const first = await instance.networkKey(db, "ip4:203.0.113.7");
    const keys = await storedKey(db);
    expect(keys).toHaveLength(1);
    expect(keys[0].byteLength).toBe(32);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(createHmac("sha256", keys[0]).update("ip4:203.0.113.7").digest("hex"));
    expect(await instance.networkKey(db, "ip4:203.0.113.7")).toBe(first);
    expect(await instance.networkKey(db, "ip4:203.0.113.8")).not.toBe(first);

    // The row changing under a running instance does not change its answers: the key is read once.
    await db.update(serverKeys).set({ hmacKey: new Uint8Array(32).fill(7) });
    expect(await instance.networkKey(db, "ip4:203.0.113.7")).toBe(first);
  });

  it("uses the key another instance already stored, and never replaces it", async () => {
    const db = await createTestDb();
    const existing = new Uint8Array(32).fill(1);
    await db.insert(serverKeys).values({ id: 1, hmacKey: existing });
    const instance = await freshInstance();

    expect(await instance.networkKey(db, "ip6:2001:db8:aa:bb::/64")).toBe(
      createHmac("sha256", existing).update("ip6:2001:db8:aa:bb::/64").digest("hex"),
    );
    expect(await storedKey(db)).toEqual([existing]);
  });

  it("refuses a stored key that is not 32 bytes, and tries again on the next call instead of caching the failure", async () => {
    const db = await createTestDb();
    await db.insert(serverKeys).values({ id: 1, hmacKey: new Uint8Array(0) });
    const instance = await freshInstance();

    await expect(instance.networkKey(db, "ip4:203.0.113.7")).rejects.toThrow("no usable server key");

    const repaired = new Uint8Array(32).fill(2);
    await db.update(serverKeys).set({ hmacKey: repaired });
    expect(await instance.networkKey(db, "ip4:203.0.113.7")).toBe(
      createHmac("sha256", repaired).update("ip4:203.0.113.7").digest("hex"),
    );
  });
});

describe("tooMany", () => {
  it("answers 429 rate_limited with Retry-After of one window and no-store", async () => {
    const response = tooMany();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe('{"error":{"code":"rate_limited"}}');
  });
});

describe("LIMITS", () => {
  it("holds the agreed numbers, all per minute, each in its own bucket", () => {
    expect(
      Object.fromEntries(Object.entries(LIMITS).map(([name, limit]) => [name, [limit.limit, limit.windowSeconds]])),
    ).toEqual({
      createGroup: [60, 60],
      sampleTrip: [10, 60],
      fx: [60, 60],
      groupWritePerNetwork: [600, 60],
      groupWritePerGroup: [120, 60],
      groupRead: [600, 60],
    });
    const buckets = Object.values(LIMITS).map((limit) => limit.bucket);
    expect(new Set(buckets).size).toBe(buckets.length);
  });
});

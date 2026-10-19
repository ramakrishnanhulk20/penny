import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimits, serverKeys } from "@/db/schema";
import { json } from "@/lib/http";

export type Limit = { bucket: string; limit: number; windowSeconds: number };

// Every limit counts per minute, so a refused client is always told the same wait.
const WINDOW_SECONDS = 60;
const UNKNOWN_NETWORK = "unknown";
const SERVER_KEY_BYTES = 32;
const SWEEP_OLDER_THAN_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;

/**
 * The request limits, each a fixed window per client network unless named per group. TestSprite runs up to 21 tests
 * at once, sometimes two runs together, from a few cloud addresses, which is why the per-network numbers are not
 * lower. groupRead also counts /api/checks, so its bucket is named for every read.
 */
export const LIMITS: {
  createGroup: Limit;
  sampleTrip: Limit;
  fx: Limit;
  groupWritePerNetwork: Limit;
  groupWritePerGroup: Limit;
  groupRead: Limit;
} = {
  createGroup: { bucket: "create-group", limit: 60, windowSeconds: WINDOW_SECONDS },
  sampleTrip: { bucket: "sample-trip", limit: 10, windowSeconds: WINDOW_SECONDS },
  fx: { bucket: "fx", limit: 60, windowSeconds: WINDOW_SECONDS },
  groupWritePerNetwork: { bucket: "group-write", limit: 600, windowSeconds: WINDOW_SECONDS },
  groupWritePerGroup: { bucket: "group-write-per-group", limit: 120, windowSeconds: WINDOW_SECONDS },
  groupRead: { bucket: "read", limit: 600, windowSeconds: WINDOW_SECONDS },
};

/** 429 {"error":{"code":"rate_limited"}} with Retry-After set to the window every limit uses, and Cache-Control no-store. */
export function tooMany(): Response {
  const response = json({ error: { code: "rate_limited" } }, { status: 429 });
  response.headers.set("Retry-After", String(WINDOW_SECONDS));
  return response;
}

// Eight 16-bit groups, read through the WHATWG URL parser so every spelling of one address gives the same groups.
// Zone ids and anything the parser refuses give null.
function ipv6Groups(address: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname;
  } catch {
    return null;
  }
  const inner = host.slice(1, -1);
  const [head, tail] = inner.includes("::") ? inner.split("::") : [inner, null];
  const left = head === "" ? [] : head.split(":");
  const right = tail === null || tail === "" ? [] : tail.split(":");
  const filled = tail === null ? [] : Array<string>(8 - left.length - right.length).fill("0");
  const groups = [...left, ...filled, ...right].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 && groups.every((part) => part >= 0 && part <= 0xffff) ? groups : null;
}

/**
 * The client network a request counts against, from the address the platform supplies: the first value of
 * x-vercel-forwarded-for, else x-real-ip. Vercel sets both itself and overwrites what a client sends. An IPv4 address
 * is its own network; an IPv6 address counts as its /64, since one subscriber is usually handed a whole /64; an
 * IPv4-mapped IPv6 address counts as the IPv4 address. A missing or unreadable address puts the request in one
 * shared "unknown" network, so leaving the header out never escapes the limit.
 */
export function clientNetwork(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for");
  const address = (forwarded === null ? (headers.get("x-real-ip") ?? "") : forwarded.split(",")[0]).trim();
  const family = isIP(address);
  if (family === 4) return `ip4:${address}`;
  if (family !== 6) return UNKNOWN_NETWORK;
  const groups = ipv6Groups(address);
  if (groups === null) return UNKNOWN_NETWORK;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    return `ip4:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `ip6:${groups
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

async function readServerKey(db: Db): Promise<Uint8Array | undefined> {
  const [row] = await db.select({ hmacKey: serverKeys.hmacKey }).from(serverKeys).where(eq(serverKeys.id, 1));
  return row?.hmacKey;
}

// Two instances starting together both insert; the conflict keeps the first key and both read that one back.
async function loadServerKey(db: Db): Promise<Uint8Array> {
  let key = await readServerKey(db);
  if (key === undefined) {
    await db.insert(serverKeys).values({ id: 1, hmacKey: randomBytes(SERVER_KEY_BYTES) }).onConflictDoNothing();
    key = await readServerKey(db);
  }
  // A short or empty key would make every network's hash easy to reverse, so anything else is refused.
  if (key === undefined || key.byteLength !== SERVER_KEY_BYTES) throw new Error("rate limit: no usable server key");
  return key;
}

let serverKey: Promise<Uint8Array> | null = null;

/**
 * HMAC-SHA256 of `network` as 64 lowercase hex characters, keyed with the server_keys row. The first call on an
 * instance reads that row, creating it with 32 random bytes if no instance has yet, and later calls reuse the key.
 * The hash is what rate_limits stores, so the table never holds an address that can be read back. Throws when the
 * database fails or the stored key is not 32 bytes; a failed load is not cached, so the next call tries again.
 */
export async function networkKey(db: Db, network: string): Promise<string> {
  serverKey ??= loadServerKey(db).catch((error: unknown) => {
    serverKey = null;
    throw error;
  });
  return createHmac("sha256", await serverKey)
    .update(network, "utf8")
    .digest("hex");
}

const lastSweep = new Map<string, number>();

/**
 * Counts one request from `key` against `limit` and says whether it is within limit.limit requests for the current
 * fixed window of limit.windowSeconds, counted from the Unix epoch. The count is one atomic upsert on a rate_limits
 * row, so it holds across every instance and concurrent requests cannot both take the last place. Requests over the
 * limit are still counted. Rows of this key's earlier windows in the bucket are deleted, and at most once a minute
 * per instance and bucket, every window of the bucket older than a day goes too. Returns true when the request may go
 * ahead. Throws when the database fails, when the key is empty, or when the limit or window is not a positive whole
 * number.
 */
export async function takeRateLimit(db: Db, limit: Limit, key: string): Promise<boolean> {
  const { bucket, limit: allowed, windowSeconds } = limit;
  if (!Number.isInteger(allowed) || allowed < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("rate limit: bad settings");
  }
  if (bucket === "" || key === "") throw new Error("rate limit: empty bucket or key");
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ bucket, key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  await db
    .delete(rateLimits)
    .where(and(eq(rateLimits.bucket, bucket), eq(rateLimits.key, key), lt(rateLimits.windowStart, windowStart)));
  const swept = lastSweep.get(bucket);
  if (swept === undefined || now - swept >= SWEEP_EVERY_MS) {
    lastSweep.set(bucket, now);
    await db
      .delete(rateLimits)
      .where(and(eq(rateLimits.bucket, bucket), lt(rateLimits.windowStart, new Date(now - SWEEP_OLDER_THAN_MS))));
  }
  return row !== undefined && row.count <= allowed;
}

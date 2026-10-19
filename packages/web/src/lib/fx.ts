import { isIP } from "node:net";
import { currency, formatRate, parseRate, type Currency } from "@penny/core";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fxCache, rateLimits } from "@/db/schema";

export type FxRate = { readonly rate: string; readonly date: string };

/** The label the page shows next to a prefilled rate. */
export const FX_SOURCE = "ECB reference rate";

// frankfurter serves the ECB's daily reference rates. Its old api.frankfurter.app address now only redirects here,
// and redirects are refused, so this origin and path are the only place a rate can come from (threat model C19).
const FX_ORIGIN = "https://api.frankfurter.dev";
const FX_PATH = "/v1/latest";
const CALL_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CACHE_FOR_MS = 12 * 60 * 60 * 1000;
// The ECB published its first euro reference rates on this day, so no genuine rate is older.
const FIRST_RATE_DATE = "1999-01-04";
// [0-9] is ASCII only in a JavaScript regex without the u flag, so full-width digits are refused.
const DATE_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const UNKNOWN_NETWORK = "unknown";

function isRateDate(text: string): boolean {
  if (!DATE_FORMAT.test(text) || text < FIRST_RATE_DATE) return false;
  const day = new Date(`${text}T00:00:00.000Z`);
  // A date like 2026-02-30 rolls over to March, so the round trip catches every day that does not exist.
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

// String() gives a JSON number's shortest round-trip decimal. Anything it writes with an exponent is either too small
// or too large to be a rate parseRate can hold, so it is refused rather than expanded.
function rateFromNumber(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  if (/[eE]/.test(text)) return null;
  const parsed = parseRate(text);
  return parsed.ok ? formatRate(parsed.value) : null;
}

/**
 * Reads one frankfurter answer for `from` to `to`. Accepts it only when it is a JSON object whose `amount` is 1,
 * whose `base` is exactly from's code, whose `date` is a real calendar day from 1999-01-04 on, and whose `rates` has
 * its own key for to's code holding a JSON number that parseRate accepts once written as its shortest decimal (so no
 * exponent, sign, zero, more than 10 decimals or value over 1000000). Returns the rate in parseRate's canonical form,
 * or null for anything else.
 */
export function readRateBody(text: string, from: Currency, to: Currency): FxRate | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { amount, base, date, rates } = body as Record<string, unknown>;
  if (amount !== 1 || base !== from.code || typeof date !== "string" || !isRateDate(date)) return null;
  if (typeof rates !== "object" || rates === null || Array.isArray(rates) || !Object.hasOwn(rates, to.code)) return null;
  const rate = rateFromNumber((rates as Record<string, unknown>)[to.code]);
  return rate === null ? null : { rate, date };
}

// Both codes already passed currency(), so each is exactly three uppercase ASCII letters; the URL library still does
// the encoding, so no code can add a parameter or change the path.
function rateUrl(from: Currency, to: Currency): URL {
  const url = new URL(FX_PATH, FX_ORIGIN);
  url.searchParams.set("from", from.code);
  url.searchParams.set("to", to.code);
  return url;
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("fx: response refused");
  }
  // Counted as the bytes arrive, after any decompression, so a small compressed body cannot unpack past the cap.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("fx: response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Asks frankfurter for the latest ECB reference rate from `from` to `to`, at
 * https://api.frankfurter.dev/v1/latest?from=XXX&to=YYY and nowhere else. Redirects are refused, the call gives up
 * after 5 s, and a body over 64 KB is refused. Returns null on any failure: a network error, a timeout, a redirect,
 * any status but 200, an oversize or non-UTF-8 body, or an answer readRateBody refuses. Never throws and never
 * returns a default rate.
 */
export async function fetchRate(fetchImpl: typeof fetch, from: Currency, to: Currency): Promise<FxRate | null> {
  try {
    const url = rateUrl(from, to);
    if (url.origin !== FX_ORIGIN) return null;
    const response = await fetchImpl(url.href, {
      headers: { Accept: "application/json", "User-Agent": "penny-fx" },
      redirect: "error",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return readRateBody(await readCapped(response), from, to);
  } catch {
    return null;
  }
}

// A row stamped in the future (a server with a fast clock) counts as expired, so a bad clock cannot pin a rate.
function isFresh(fetchedAt: Date, now: Date): boolean {
  const age = now.getTime() - fetchedAt.getTime();
  return age >= 0 && age < CACHE_FOR_MS;
}

// A stored row is read back as untrusted and passes the same rate and date checks as a fresh answer.
function storedRate(rate: string, date: string): FxRate | null {
  const parsed = parseRate(rate);
  if (!parsed.ok || !isRateDate(date)) return null;
  return { rate: formatRate(parsed.value), date };
}

/**
 * The ECB reference rate from `from` to `to`, shared by every instance through the fx_cache table: a pair fetched
 * less than 12 hours before `now` is served from the table without calling frankfurter; otherwise fetchRate runs
 * and a good answer is stored, stamped with `now`. A failed fetch is not stored and gives null. The same currency on
 * both sides gives null. Throws only when the database fails.
 */
export async function referenceRate(
  db: Db,
  fetchImpl: typeof fetch,
  from: Currency,
  to: Currency,
  now: Date,
): Promise<FxRate | null> {
  if (from.code === to.code) return null;
  const pair = `${from.code}:${to.code}`;
  const [row] = await db.select().from(fxCache).where(eq(fxCache.pair, pair)).limit(1);
  if (row !== undefined && isFresh(row.fetchedAt, now)) {
    const cached = storedRate(row.rate, row.rateDate);
    if (cached !== null) return cached;
  }
  const fetched = await fetchRate(fetchImpl, from, to);
  if (fetched === null) return null;
  await db
    .insert(fxCache)
    .values({ pair, rate: fetched.rate, rateDate: fetched.date, fetchedAt: now })
    .onConflictDoUpdate({ target: fxCache.pair, set: { rate: fetched.rate, rateDate: fetched.date, fetchedAt: now } });
  return fetched;
}

/**
 * Reads the pair from a /api/fx query. Accepts exactly one `from` and one `to` and no other parameter, each a code
 * that core's currency() accepts, and the two different. Returns null for anything else.
 */
export function readPair(params: URLSearchParams): { from: Currency; to: Currency } | null {
  const names = [...params.keys()];
  if (names.length !== 2 || params.getAll("from").length !== 1 || params.getAll("to").length !== 1) return null;
  const from = currency(params.get("from") ?? "");
  const to = currency(params.get("to") ?? "");
  if (from === null || to === null || from.code === to.code) return null;
  return { from, to };
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

/**
 * Counts one request from `key` in `bucket` and says whether it is within `limit` requests for the current fixed
 * window of `windowSeconds`, counted from the Unix epoch. The count is one atomic upsert on a rate_limits row, so it
 * holds across every instance and concurrent requests cannot both take the last place. Requests over the limit are
 * still counted. Rows of this key's earlier windows in the bucket are deleted, so a client keeps at most one row.
 * Returns true when the request may go ahead. Throws when the database fails or limit or windowSeconds is not a
 * positive whole number.
 */
export async function takeRateLimit(
  db: Db,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("rate limit: bad settings");
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
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
  return row !== undefined && row.count <= limit;
}

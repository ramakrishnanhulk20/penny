import { currency, formatRate, parseRate, type Currency } from "@penny/core";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fxCache } from "@/db/schema";

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
const NO_RATE_FOR_MS = 60 * 60 * 1000;
const FAILED_FOR_MS = 60 * 1000;
// Stored in the rate column when frankfurter answered that it has no rate for the pair, so a pair the ECB does not
// publish costs at most one upstream call an hour however often it is asked for. parseRate refuses it, so it can never
// be served as a rate.
const NO_RATE = "";
// Stored when frankfurter could not be read at all (an error status, a timeout, an answer that fails its checks). That
// says nothing about the pair, so it is kept for a minute only: one bad answer never hides a rate for an hour.
const UPSTREAM_FAILED = "failed";
const DAY_MS = 24 * 60 * 60 * 1000;
// The ECB publishes on working days, so the latest rate is at most a long holiday old. Anything older means frankfurter
// has stopped updating, and a date after tomorrow cannot be real in any time zone.
const OLDEST_RATE_DAYS = 10;
// [0-9] is ASCII only in a JavaScript regex without the u flag, so full-width digits are refused.
const DATE_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A real calendar day from OLDEST_RATE_DAYS before `now`'s UTC day to the day after it. YYYY-MM-DD text sorts as the
// days do, so the bounds are plain string comparisons.
function isRateDate(text: string, now: Date): boolean {
  if (!DATE_FORMAT.test(text)) return false;
  const day = new Date(`${text}T00:00:00.000Z`);
  // A date like 2026-02-30 rolls over to March, so the round trip catches every day that does not exist.
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) return false;
  return text >= utcDay(now.getTime() - OLDEST_RATE_DAYS * DAY_MS) && text <= utcDay(now.getTime() + DAY_MS);
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

// What one call to frankfurter said: a rate, that it has none for the pair, or nothing that can be trusted.
type Answer =
  | { readonly kind: "rate"; readonly rate: FxRate }
  | { readonly kind: "absent" }
  | { readonly kind: "failed" };

const ABSENT: Answer = { kind: "absent" };
const FAILED: Answer = { kind: "failed" };

function readAnswer(text: string, from: Currency, to: Currency, now: Date): Answer {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return FAILED;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return FAILED;
  const { amount, base, date, rates } = body as Record<string, unknown>;
  if (amount !== 1 || base !== from.code || typeof date !== "string" || !isRateDate(date, now)) return FAILED;
  if (typeof rates !== "object" || rates === null || Array.isArray(rates)) return FAILED;
  // Everything else checked out, so a missing key is frankfurter saying it has no rate for this pair.
  if (!Object.hasOwn(rates, to.code)) return ABSENT;
  const rate = rateFromNumber((rates as Record<string, unknown>)[to.code]);
  return rate === null ? FAILED : { kind: "rate", rate: { rate, date } };
}

/**
 * Reads one frankfurter answer for `from` to `to`. Accepts it only when it is a JSON object whose `amount` is 1,
 * whose `base` is exactly from's code, whose `date` is a real calendar day no later than the day after `now` and no
 * more than 10 days before `now`'s day (both in UTC), and whose `rates` has its own key for to's code holding a JSON
 * number that parseRate accepts once written as its shortest decimal (so no exponent, sign, zero, more than 10 decimals
 * or value over 1000000). Returns the rate in parseRate's canonical form, or null for anything else.
 */
export function readRateBody(text: string, from: Currency, to: Currency, now: Date): FxRate | null {
  const answer = readAnswer(text, from, to, now);
  return answer.kind === "rate" ? answer.rate : null;
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

// One call to frankfurter. A 404 is its own answer for a pair it does not serve; every other status but 200, a
// redirect, a network error, a timeout and an oversize or non-UTF-8 body are failures that say nothing about the pair.
async function askFrankfurter(fetchImpl: typeof fetch, from: Currency, to: Currency, now: Date): Promise<Answer> {
  try {
    const url = rateUrl(from, to);
    if (url.origin !== FX_ORIGIN) return FAILED;
    const response = await fetchImpl(url.href, {
      headers: { Accept: "application/json", "User-Agent": "penny-fx" },
      redirect: "error",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === 404 && !response.redirected ? ABSENT : FAILED;
    }
    return readAnswer(await readCapped(response), from, to, now);
  } catch {
    return FAILED;
  }
}

/**
 * Asks frankfurter for the latest ECB reference rate from `from` to `to`, at
 * https://api.frankfurter.dev/v1/latest?from=XXX&to=YYY and nowhere else. Redirects are refused, the call gives up
 * after 5 s, and a body over 64 KB is refused. Returns null on any failure: a network error, a timeout, a redirect,
 * any status but 200, an oversize or non-UTF-8 body, or an answer readRateBody refuses for `now`. Never throws and
 * never returns a default rate.
 */
export async function fetchRate(
  fetchImpl: typeof fetch,
  from: Currency,
  to: Currency,
  now: Date,
): Promise<FxRate | null> {
  const answer = await askFrankfurter(fetchImpl, from, to, now);
  return answer.kind === "rate" ? answer.rate : null;
}

// A row stamped in the future (a server with a fast clock) counts as expired, so a bad clock cannot pin a rate.
function isFresh(fetchedAt: Date, now: Date, forMs: number): boolean {
  const age = now.getTime() - fetchedAt.getTime();
  return age >= 0 && age < forMs;
}

// A stored row is read back as untrusted and passes the same rate and date checks as a fresh answer.
function storedRate(rate: string, date: string, now: Date): FxRate | null {
  const parsed = parseRate(rate);
  if (!parsed.ok || !isRateDate(date, now)) return null;
  return { rate: formatRate(parsed.value), date };
}

// Asks frankfurter and stores what it said, stamped with `now`: the rate, or which kind of "no rate" it was.
async function refresh(
  db: Db,
  fetchImpl: typeof fetch,
  from: Currency,
  to: Currency,
  now: Date,
): Promise<FxRate | null> {
  const answer = await askFrankfurter(fetchImpl, from, to, now);
  // The date column needs a day; for either kind of "no rate" it is the day of the try, and it is never read back.
  const noRate = answer.kind === "absent" ? NO_RATE : UPSTREAM_FAILED;
  const stored = answer.kind === "rate" ? answer.rate : { rate: noRate, date: utcDay(now.getTime()) };
  await db
    .insert(fxCache)
    .values({ pair: `${from.code}:${to.code}`, rate: stored.rate, rateDate: stored.date, fetchedAt: now })
    .onConflictDoUpdate({ target: fxCache.pair, set: { rate: stored.rate, rateDate: stored.date, fetchedAt: now } });
  return answer.kind === "rate" ? answer.rate : null;
}

// One upstream call in flight per pair on this instance. Lookups that miss the table while it runs wait for its answer
// instead of each asking frankfurter, so a burst of lookups for a new pair costs one call.
const inFlight = new Map<string, Promise<FxRate | null>>();

/**
 * The ECB reference rate from `from` to `to`, shared by every instance through the fx_cache table: a pair fetched
 * less than 12 hours before `now` is served from the table without calling frankfurter; otherwise frankfurter is asked
 * and its answer is stored, stamped with `now`. Concurrent lookups of one pair on one instance share that one call.
 * When frankfurter answers that it has no rate for the pair (a 404, or a good answer without the pair), the pair gives
 * null for the next hour without calling it again; when frankfurter cannot be read (any other status, a timeout, a
 * redirect, an answer that fails its checks, a date more than 10 days old or after tomorrow), for the next minute. The
 * same currency on both sides gives null. Throws only when the database fails.
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
  if (row !== undefined && row.rate === NO_RATE && isFresh(row.fetchedAt, now, NO_RATE_FOR_MS)) return null;
  if (row !== undefined && row.rate === UPSTREAM_FAILED && isFresh(row.fetchedAt, now, FAILED_FOR_MS)) return null;
  if (row !== undefined && isFresh(row.fetchedAt, now, CACHE_FOR_MS)) {
    const cached = storedRate(row.rate, row.rateDate, now);
    if (cached !== null) return cached;
  }
  const running = inFlight.get(pair);
  if (running !== undefined) return running;
  const asked = refresh(db, fetchImpl, from, to, now).finally(() => inFlight.delete(pair));
  inFlight.set(pair, asked);
  return asked;
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

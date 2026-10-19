// Not covered: the live frankfurter service (every call here goes to a fake fetch; the live answer was checked once by
// hand with curl); a 5 s timeout actually firing (only that every call carries a timeout signal); Node's own fetch
// refusing a redirect (only that every call asks it to); two real Postgres sessions racing on one rate_limits row,
// because PGlite runs a single session; Vercel setting its address headers (the tests set them by hand); and the
// expense form in a browser.
import { currency, type Currency } from "@penny/core";
import { count } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/fx/route";
import { setDbForTests } from "@/db/client";
import { fxCache, rateLimits } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { fetchRate, referenceRate } from "@/lib/fx";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

const USD_EUR_URL = "https://api.frankfurter.dev/v1/latest?from=USD&to=EUR";
// Exactly what frankfurter answered on 19 Oct 2026.
const GOOD = '{"amount":1.0,"base":"USD","date":"2026-10-16","rates":{"EUR":0.88865}}';
const FOUND = { rate: "0.88865", date: "2026-10-16" };
const MAX_BYTES = 64 * 1024;

function known(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error(`unknown test currency ${code}`);
  return found;
}

const USD = known("USD");
const EUR = known("EUR");

type Call = { readonly url: string; readonly init: RequestInit | undefined };

// Records every call and answers each with a fresh Response, since a body can be read only once.
function fakeFrankfurter(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return answer();
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

function answering(text: string, status = 200): () => Response {
  return () => new Response(text, { status, headers: { "content-type": "application/json" } });
}

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({ amount: 1, base: "USD", date: "2026-10-16", rates: { EUR: 0.88865 }, ...fields });
}

function fxRequest(query: string, address = "203.0.113.7"): Request {
  return new Request(`http://localhost/api/fx${query}`, { headers: { "x-vercel-forwarded-for": address } });
}

afterEach(() => {
  setDbForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchRate", () => {
  it("calls only https://api.frankfurter.dev/v1/latest with from and to, refusing redirects, with a timeout", async () => {
    const frankfurter = fakeFrankfurter(answering(GOOD));

    expect(await fetchRate(frankfurter.fetchImpl, USD, EUR)).toEqual(FOUND);

    expect(frankfurter.calls).toHaveLength(1);
    const [call] = frankfurter.calls;
    expect(call.url).toBe(USD_EUR_URL);
    expect(new URL(call.url).origin).toBe("https://api.frankfurter.dev");
    expect(call.init?.redirect).toBe("error");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a rate with trailing zeros, in canonical form", answer({ rates: { EUR: 0.92 } }), "0.92"],
    ["a rate written with an exponent that is an ordinary decimal", GOOD.replace("0.88865", "8.8865e-1"), "0.88865"],
    ["a whole-number rate", answer({ base: "USD", rates: { EUR: 2 } }), "2"],
    ["a rate with exactly 10 decimals", answer({ rates: { EUR: 0.0000641234 } }), "0.0000641234"],
  ])("accepts %s", async (_label, text, rate) => {
    expect(await fetchRate(fakeFrankfurter(answering(text)).fetchImpl, USD, EUR)).toEqual({ rate, date: "2026-10-16" });
  });

  it.each([
    ["an exponent too small for a rate", answer({ rates: { EUR: 1e-7 } })],
    ["an exponent too large for a rate", answer({ rates: { EUR: 1e21 } })],
    ["a negative rate", answer({ rates: { EUR: -0.88865 } })],
    ["a zero rate", answer({ rates: { EUR: 0 } })],
    ["more than 10 decimals", answer({ rates: { EUR: 0.12345678901 } })],
    ["a rate over 1000000", answer({ rates: { EUR: 1000001 } })],
    ["a rate written as a string", answer({ rates: { EUR: "0.88865" } })],
    ["a base other than the one asked for", answer({ base: "GBP" })],
    ["an amount other than 1", answer({ amount: 100 })],
    ["no key for the currency asked for", answer({ rates: { GBP: 0.77 } })],
    ["a key for the asked currency in another case", answer({ rates: { eur: 0.88865 } })],
    ["no rates at all", answer({ rates: null })],
    ["a date that does not exist", answer({ date: "2026-02-30" })],
    ["a date before the ECB's first rates", answer({ date: "1998-12-31" })],
    ["a date with a time", answer({ date: "2026-10-16T00:00:00Z" })],
    ["an array", `[${GOOD}]`],
    ["text that is not JSON", "<html>301 Moved Permanently</html>"],
  ])("refuses %s", async (_label, text) => {
    expect(await fetchRate(fakeFrankfurter(answering(text)).fetchImpl, USD, EUR)).toBeNull();
  });

  it("refuses a body over 64 KB, read or declared, and accepts one of exactly 64 KB", async () => {
    expect(await fetchRate(fakeFrankfurter(answering(GOOD.padEnd(MAX_BYTES, " "))).fetchImpl, USD, EUR)).toEqual(FOUND);
    expect(await fetchRate(fakeFrankfurter(answering(GOOD.padEnd(MAX_BYTES + 1, " "))).fetchImpl, USD, EUR)).toBeNull();

    const declared = () =>
      new Response(GOOD, { status: 200, headers: { "content-length": String(MAX_BYTES + 1) } });
    expect(await fetchRate(fakeFrankfurter(declared).fetchImpl, USD, EUR)).toBeNull();
  });

  it("refuses a redirect, even to the same origin, and never follows it", async () => {
    const redirect = fakeFrankfurter(
      () => new Response(null, { status: 301, headers: { location: "https://api.frankfurter.dev/v2/rates" } }),
    );
    expect(await fetchRate(redirect.fetchImpl, USD, EUR)).toBeNull();
    expect(redirect.calls.map((call) => call.url)).toEqual([USD_EUR_URL]);

    // What Node's fetch does with redirect: "error" when the server redirects.
    const refused = fakeFrankfurter(() => {
      throw new TypeError("fetch failed: unexpected redirect");
    });
    expect(await fetchRate(refused.fetchImpl, USD, EUR)).toBeNull();
  });

  it.each([
    ["the not-found answer frankfurter gives a pair it does not serve", answering('{"message":"not found"}', 404)],
    ["a server error", answering(GOOD, 500)],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("gives no rate for %s", async (_label, reply) => {
    expect(await fetchRate(fakeFrankfurter(reply).fetchImpl, USD, EUR)).toBeNull();
  });
});

describe("referenceRate", () => {
  const T0 = new Date("2026-10-19T12:00:00.000Z");
  const after = (ms: number) => new Date(T0.getTime() + ms);
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  it("serves a pair from the table for 12 hours, then asks frankfurter again", async () => {
    const db = await createTestDb();
    const frankfurter = fakeFrankfurter(answering(GOOD));

    expect(await referenceRate(db, frankfurter.fetchImpl, USD, EUR, T0)).toEqual(FOUND);
    expect(await db.select().from(fxCache)).toEqual([
      { pair: "USD:EUR", rate: "0.88865", rateDate: "2026-10-16", fetchedAt: T0 },
    ]);
    expect(await referenceRate(db, frankfurter.fetchImpl, USD, EUR, after(TWELVE_HOURS - 1))).toEqual(FOUND);
    expect(frankfurter.calls).toHaveLength(1);

    expect(await referenceRate(db, frankfurter.fetchImpl, USD, EUR, after(TWELVE_HOURS))).toEqual(FOUND);
    expect(frankfurter.calls).toHaveLength(2);
    const [row] = await db.select().from(fxCache);
    expect(row.fetchedAt).toEqual(after(TWELVE_HOURS));
  });

  it("remembers a failure as no rate for an hour, then asks frankfurter again", async () => {
    const db = await createTestDb();
    const missing = fakeFrankfurter(answering("{}", 404));

    expect(await referenceRate(db, missing.fetchImpl, USD, EUR, T0)).toBeNull();
    expect(await db.select().from(fxCache)).toEqual([{ pair: "USD:EUR", rate: "", rateDate: "2026-10-19", fetchedAt: T0 }]);
    expect(await referenceRate(db, missing.fetchImpl, USD, EUR, after(ONE_HOUR - 1))).toBeNull();
    expect(missing.calls).toHaveLength(1);

    const frankfurter = fakeFrankfurter(answering(GOOD));
    expect(await referenceRate(db, frankfurter.fetchImpl, USD, EUR, after(ONE_HOUR))).toEqual(FOUND);
    expect(frankfurter.calls).toHaveLength(1);
    expect(await db.select().from(fxCache)).toEqual([
      { pair: "USD:EUR", rate: "0.88865", rateDate: "2026-10-16", fetchedAt: after(ONE_HOUR) },
    ]);
  });

  it("does not serve a stored row that fails the rate check, and keeps one pair from answering another", async () => {
    const db = await createTestDb();
    await db.insert(fxCache).values({ pair: "USD:EUR", rate: "-1", rateDate: "2026-10-16", fetchedAt: T0 });
    const frankfurter = fakeFrankfurter(answering(GOOD));

    expect(await referenceRate(db, frankfurter.fetchImpl, USD, EUR, after(1000))).toEqual(FOUND);
    expect(frankfurter.calls).toHaveLength(1);

    const reverse = fakeFrankfurter(answering('{"amount":1.0,"base":"EUR","date":"2026-10-16","rates":{"USD":1.1253}}'));
    expect(await referenceRate(db, reverse.fetchImpl, EUR, USD, after(2000))).toEqual({ rate: "1.1253", date: "2026-10-16" });
    expect(reverse.calls.map((call) => call.url)).toEqual(["https://api.frankfurter.dev/v1/latest?from=EUR&to=USD"]);
  });
});

describe("GET /api/fx", () => {
  it("answers the rate, its date and its source, and serves it from the table on the next request", async () => {
    setDbForTests(await createTestDb());
    const frankfurter = fakeFrankfurter(answering(GOOD));
    vi.stubGlobal("fetch", frankfurter.fetchImpl);

    for (let i = 0; i < 2; i += 1) {
      const response = await GET(fxRequest("?from=USD&to=EUR"));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe('{"rate":"0.88865","date":"2026-10-16","source":"ECB reference rate"}');
    }
    expect(frankfurter.calls.map((call) => call.url)).toEqual([USD_EUR_URL]);
  });

  // The last two are what the service does if v1 is switched off: the address stops answering, or it redirects.
  it.each([
    ["a pair the ECB does not publish", answering('{"message":"not found"}', 404)],
    ["a refused answer", answering(answer({ base: "GBP" }))],
    ["v1 gone", answering("<html>Gone</html>", 410)],
    ["v1 redirected to v2", () => new Response(null, { status: 301, headers: { location: "https://api.frankfurter.dev/v2/rates" } })],
  ])("answers 404 no_rate, never a default rate, for %s", async (_label, reply) => {
    setDbForTests(await createTestDb());
    vi.stubGlobal("fetch", fakeFrankfurter(reply).fetchImpl);

    const response = await GET(fxRequest("?from=USD&to=VND"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":{"code":"no_rate"}}');
  });

  it("asks frankfurter once about a pair it does not publish, however often it is looked up within the hour", async () => {
    setDbForTests(await createTestDb());
    const frankfurter = fakeFrankfurter(answering('{"message":"not found"}', 404));
    vi.stubGlobal("fetch", frankfurter.fetchImpl);

    for (let i = 0; i < 2; i += 1) {
      const response = await GET(fxRequest("?from=USD&to=VND"));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('{"error":{"code":"no_rate"}}');
    }
    expect(frankfurter.calls.map((call) => call.url)).toEqual(["https://api.frankfurter.dev/v1/latest?from=USD&to=VND"]);
  });

  it.each([
    ["no query", ""],
    ["a missing to", "?from=USD"],
    ["a lower-case code", "?from=usd&to=EUR"],
    ["a code with no minor unit", "?from=XAU&to=EUR"],
    ["an unknown code", "?from=ZZZ&to=EUR"],
    ["the same currency twice", "?from=EUR&to=EUR"],
    ["a repeated from", "?from=USD&from=GBP&to=EUR"],
    ["an extra parameter", "?from=USD&to=EUR&amount=100"],
    ["a code with a smuggled parameter", "?from=USD%26to%3DGBP&to=EUR"],
    ["a padded code", "?from=USD%20&to=EUR"],
  ])("answers 400 invalid_body for %s, counted once against the limit and with no upstream call", async (_label, query) => {
    const db = await createTestDb();
    setDbForTests(db);
    const frankfurter = fakeFrankfurter(answering(GOOD));
    vi.stubGlobal("fetch", frankfurter.fetchImpl);

    const response = await GET(fxRequest(query));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":{"code":"invalid_body"}}');
    expect(frankfurter.calls).toEqual([]);
    expect(await db.select({ n: count() }).from(rateLimits)).toEqual([{ n: 1 }]);
  });

  it("answers 429 rate_limited to the 61st request from one network in a minute, and again in the next minute", async () => {
    setDbForTests(await createTestDb());
    vi.stubGlobal("fetch", fakeFrankfurter(answering(GOOD)).fetchImpl);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:05.000Z"));

    // Both addresses sit in one /64, so they share one count.
    for (let i = 0; i < 60; i += 1) {
      const address = i % 2 === 0 ? "2001:db8:aa:bb::1" : "2001:db8:aa:bb:ffff::2";
      expect((await GET(fxRequest("?from=USD&to=EUR", address))).status).toBe(200);
    }
    const limited = await GET(fxRequest("?from=USD&to=EUR", "2001:db8:aa:bb::3"));
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{"error":{"code":"rate_limited"}}');
    expect((await GET(fxRequest("?from=USD&to=EUR", "2001:db8:aa:cc::1"))).status).toBe(200);

    vi.setSystemTime(new Date("2026-10-19T12:01:00.000Z"));
    expect((await GET(fxRequest("?from=USD&to=EUR", "2001:db8:aa:bb::3"))).status).toBe(200);
  });
});

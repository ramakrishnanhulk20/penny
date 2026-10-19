import { connection } from "next/server";
import { withDb } from "@/db/client";
import { FX_SOURCE, readPair, referenceRate } from "@/lib/fx";
import { badRequest, json, serverError } from "@/lib/http";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

/**
 * The latest ECB reference rate between two currencies, for prefilling the rate of a foreign expense.
 * Query: exactly `from` and `to`, two different ISO 4217 codes, nothing else.
 * 200 { rate, date, source: "ECB reference rate" }. 400 invalid_body for any other query. 404 no_rate when the ECB
 * has no rate for the pair or frankfurter's answer fails any check; never a default rate. 429 rate_limited past
 * LIMITS.fx from one client network, malformed queries included. Any other failure is a bare 500.
 */
export async function GET(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.fx, network))) return tooMany();
      const pair = readPair(new URL(request.url).searchParams);
      if (pair === null) return badRequest("invalid_body");
      const found = await referenceRate(db, fetch, pair.from, pair.to, new Date());
      if (found === null) return json({ error: { code: "no_rate" } }, { status: 404 });
      return json({ rate: found.rate, date: found.date, source: FX_SOURCE });
    });
  } catch {
    return serverError();
  }
}

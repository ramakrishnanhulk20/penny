import { connection } from "next/server";
import { withDb } from "@/db/client";
import { changeBaseCurrencyBody, parseBody } from "@/lib/api-schemas";
import type { ChangeBaseCurrencyResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, sendsNonJsonBody, serverError, unsupportedMediaType } from "@/lib/http";
import { changeBaseCurrency } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

/**
 * Reads the group named by the x-penny-group header. Writes nothing but the rate limit counts.
 * 200 GroupView. 404 not_found, byte for byte the same for a missing, malformed or unknown token.
 * 429 rate_limited past LIMITS.groupRead from one client network, or past LIMITS.groupReadPerGroup for the group the
 * token names; an unknown token is a 404 first. Any other failure is a bare 500.
 */
export async function GET(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.groupRead, network))) return tooMany();
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupReadPerGroup, group.id))) return tooMany();
      return json(await buildGroupView(db, group));
    });
  } catch {
    return serverError();
  }
}

/**
 * Changes the base currency of the group named by the x-penny-group header. Body: { baseCurrency }, nothing else.
 * 200 { group }, and the same 200 with nothing written when the group already has that base, money or not.
 * 400 invalid_body or bad_currency. 404 not_found for an unknown token. 409 base_locked for any other base once the
 * group has had any expense or payment, deleted ones included; 409 limit_reached once the group holds MAX_EVENTS
 * events.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * 415 unsupported_media_type when the request carries a body that is not declared application/json.
 * Any other failure is a bare 500.
 */
export async function PATCH(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  if (sendsNonJsonBody(request)) return unsupportedMediaType();
  try {
    // Counted on a short connection of its own, so the body below is still read with no connection held.
    const allowed = await withDb(async (db) =>
      takeRateLimit(db, LIMITS.groupWritePerNetwork, await networkKey(db, clientNetwork(request.headers))),
    );
    if (!allowed) return tooMany();
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, changeBaseCurrencyBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const changed = await changeBaseCurrency(db, group, body.value);
      if (!changed.ok) {
        if (changed.status === 404) return notFound();
        if (changed.status === 400) return badRequest(changed.code);
        return json({ error: { code: changed.code } }, { status: changed.status });
      }

      const response: ChangeBaseCurrencyResponse = { group: await buildGroupView(db, group) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

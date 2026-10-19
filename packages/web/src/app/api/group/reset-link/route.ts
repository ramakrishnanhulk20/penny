import { connection } from "next/server";
import { withDb } from "@/db/client";
import { parseBody, resetLinkBody } from "@/lib/api-schemas";
import type { ResetLinkResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, serverError } from "@/lib/http";
import { resetLink } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

/**
 * Replaces the link of the group named by the x-penny-group header. Body: {}, nothing else.
 * 200 { token, group }: the new token is the group's link secret, returned only here, and the old token gets the
 * not_found answer from this moment on.
 * 400 invalid_body. 404 not_found for an unknown token, or one another reset replaced first.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * Any other failure is a bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    // Counted on a short connection of its own, so the body below is still read with no connection held.
    const allowed = await withDb(async (db) =>
      takeRateLimit(db, LIMITS.groupWritePerNetwork, await networkKey(db, clientNetwork(request.headers))),
    );
    if (!allowed) return tooMany();
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, resetLinkBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const reset = await resetLink(db, group);
      if (!reset.ok) return notFound();

      const response: ResetLinkResponse = { token: reset.value.token, group: await buildGroupView(db, group) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

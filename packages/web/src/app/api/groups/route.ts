import { connection } from "next/server";
import { withDb } from "@/db/client";
import { createGroupBody, parseBody } from "@/lib/api-schemas";
import type { CreateGroupResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { badRequest, json, sendsNonJsonBody, serverError, unsupportedMediaType } from "@/lib/http";
import { createGroup } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

/**
 * Starts a group. Body: { name, baseCurrency, members }, nothing else.
 * 201 { token, group }: the token is the group's link secret and is returned only here.
 * 400 { error: { code } } with invalid_body, bad_name, bad_currency, too_few_members, too_many_members,
 * bad_member_name or duplicate_member_name. 429 rate_limited past LIMITS.createGroup from one client network.
 * 415 unsupported_media_type when the request carries a body that is not declared application/json.
 * Any other failure is a bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  if (sendsNonJsonBody(request)) return unsupportedMediaType();
  try {
    // Counted on a short connection of its own, so the body below is still read with no connection held.
    const allowed = await withDb(async (db) =>
      takeRateLimit(db, LIMITS.createGroup, await networkKey(db, clientNetwork(request.headers))),
    );
    if (!allowed) return tooMany();
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, createGroupBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const created = await createGroup(db, body.value);
      if (!created.ok) return badRequest(created.code);
      const response: CreateGroupResponse = {
        token: created.value.token,
        group: await buildGroupView(db, created.value.group),
      };
      return json(response, { status: 201 });
    });
  } catch {
    return serverError();
  }
}

import { connection } from "next/server";
import { withDb } from "@/db/client";
import { parseBody, resetLinkBody } from "@/lib/api-schemas";
import type { ResetLinkResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER, parseGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, sendsNonJsonBody, serverError, unsupportedMediaType } from "@/lib/http";
import { resetLink } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

// The header's token is dead. If newToken already opens a group, this is a reset sent again after its answer was lost,
// and whoever holds newToken already holds that group's link, so the group is answered and nothing is written.
async function resumed(request: Request, newToken: string): Promise<Response> {
  if (parseGroupToken(request.headers.get(GROUP_TOKEN_HEADER)) === null) return notFound();
  return withDb(async (db) => {
    const group = await resolveGroup(db, newToken);
    if (group === null) return notFound();
    if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();
    const response: ResetLinkResponse = { group: await buildGroupView(db, group) };
    return json(response);
  });
}

/**
 * Moves the group named by the x-penny-group header to a new link. Body: { newToken }, nothing else: a link token the
 * browser made and kept before sending, in the link format. Only its hash is stored.
 * 200 { group }: the header's token gets the not_found answer from this moment on, and newToken opens the group. The
 * same 200, with nothing written, when the header's token is already dead but newToken opens a group: the retry of a
 * reset whose answer was lost.
 * 400 invalid_body for a live token with a body that is not exactly that, or a newToken equal to the current token or
 * to another group's link. 404 not_found for an unknown token with any body but such a retry, or a token another reset
 * replaced first. Never 409 limit_reached: a group at its history caps can still cut off a leaked link.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * 415 unsupported_media_type when the request carries a body that is not declared application/json.
 * Any other failure is a bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  if (sendsNonJsonBody(request)) return unsupportedMediaType();
  try {
    // Settled on a short connection of their own, so the body below is still read with no connection held. A dead
    // token is not answered yet: whether it is a retry depends on the body.
    const presented = await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.groupWritePerNetwork, network))) return "limited";
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group !== null && !(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return "limited";
      return group;
    });
    if (presented === "limited") return tooMany();
    const body = await parseBody(request, resetLinkBody);
    if (presented === null) return body.ok ? await resumed(request, body.value.newToken) : notFound();
    if (!body.ok) return badRequest(body.code);

    return await withDb(async (db) => {
      const reset = await resetLink(db, presented, body.value.newToken);
      if (!reset.ok) {
        if (reset.status === 404) return notFound();
        if (reset.status === 400) return badRequest(reset.code);
        return json({ error: { code: reset.code } }, { status: reset.status });
      }
      const response: ResetLinkResponse = { group: await buildGroupView(db, presented) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

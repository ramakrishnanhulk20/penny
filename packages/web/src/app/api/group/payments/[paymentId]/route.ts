import { connection } from "next/server";
import { z } from "zod";
import { withDb } from "@/db/client";
import type { UndoPaymentResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { json, notFound, sendsNonJsonBody, serverError, unsupportedMediaType } from "@/lib/http";
import { undoPayment } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

// Checked before any query, because Postgres throws on a string it cannot read as a uuid. Covers the shape of the
// id only; whether it is a payment of this group is the store's question.
const PAYMENT_ID = z.uuid();

/**
 * Undoes one payment of the group named by the x-penny-group header.
 * 200 { group } once the payment is undone, and the same 200 with nothing written when it already was.
 * 404 not_found, byte for byte the same, for an unknown token, an id that is not a uuid, or a payment of another
 * group. 409 limit_reached once the group holds MAX_EVENTS events.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * 415 unsupported_media_type when the request carries a body that is not declared application/json.
 * Any other failure is a bare 500.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ paymentId: string }> }): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  if (sendsNonJsonBody(request)) return unsupportedMediaType();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.groupWritePerNetwork, network))) return tooMany();
      const { paymentId } = await params;
      if (!PAYMENT_ID.safeParse(paymentId).success) return notFound();
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const undone = await undoPayment(db, group, paymentId);
      if (!undone.ok) {
        if (undone.status === 404) return notFound();
        return json({ error: { code: undone.code } }, { status: undone.status });
      }

      const response: UndoPaymentResponse = { group: await buildGroupView(db, group) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

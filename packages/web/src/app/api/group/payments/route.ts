import { connection } from "next/server";
import { withDb } from "@/db/client";
import { addPaymentBody, parseBody } from "@/lib/api-schemas";
import type { AddPaymentResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, serverError } from "@/lib/http";
import { addPayment } from "@/lib/ledger-store";

/**
 * Records that one member of the group named by the x-penny-group header paid another.
 * 201 { payment, group } for a new payment. 200 with the original when the same clientId arrives again with the
 * same body; nothing is written.
 * 400 with a code from the API contract, such as self_payment. 404 not_found for an unknown token, or a `from` or
 * `to` that is not a current member of this group. 409 client_id_conflict (same clientId, different body) or
 * limit_reached. Any other failure is a bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, addPaymentBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();

      const added = await addPayment(db, group, body.value);
      if (!added.ok) {
        if (added.status === 404) return notFound();
        if (added.status === 400) return badRequest(added.code);
        return json({ error: { code: added.code } }, { status: added.status });
      }

      const view = await buildGroupView(db, group);
      const payment = view.payments.find((item) => item.id === added.value.paymentId);
      // A retry whose payment has since been undone answers like any other id that is not in this group.
      if (payment === undefined) return notFound();
      const response: AddPaymentResponse = { payment, group: view };
      return json(response, { status: added.value.status });
    });
  } catch {
    return serverError();
  }
}

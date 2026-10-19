import { connection } from "next/server";
import { z } from "zod";
import { withDb } from "@/db/client";
import type { UndoPaymentResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { json, notFound, serverError } from "@/lib/http";
import { undoPayment } from "@/lib/ledger-store";

// Checked before any query, because Postgres throws on a string it cannot read as a uuid. Covers the shape of the
// id only; whether it is a payment of this group is the store's question.
const PAYMENT_ID = z.uuid();

/**
 * Undoes one payment of the group named by the x-penny-group header.
 * 200 { group } once the payment is undone, and the same 200 with nothing written when it already was.
 * 404 not_found, byte for byte the same, for an unknown token, an id that is not a uuid, or a payment of another
 * group. Any other failure is a bare 500.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ paymentId: string }> }): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    const { paymentId } = await params;
    if (!PAYMENT_ID.safeParse(paymentId).success) return notFound();
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();

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

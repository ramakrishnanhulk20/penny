import { connection } from "next/server";
import { withDb } from "@/db/client";
import { addExpenseBody, parseBody } from "@/lib/api-schemas";
import type { AddExpenseResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, sendsNonJsonBody, serverError, unsupportedMediaType } from "@/lib/http";
import { addExpense } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

/**
 * Adds an expense to the group named by the x-penny-group header.
 * 201 { expense, group } for a new expense. 200 with the original when the same clientId arrives again with the
 * same body; nothing is written.
 * 400 with a code from the API contract. 404 not_found for an unknown token or any member id outside this group.
 * 409 client_id_conflict (same clientId, different body) or limit_reached.
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
    // Counted on a short connection of its own, so the body below is still read with no connection held.
    const allowed = await withDb(async (db) =>
      takeRateLimit(db, LIMITS.groupWritePerNetwork, await networkKey(db, clientNetwork(request.headers))),
    );
    if (!allowed) return tooMany();
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, addExpenseBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const added = await addExpense(db, group, body.value);
      if (!added.ok) {
        if (added.status === 404) return notFound();
        if (added.status === 400) return badRequest(added.code);
        return json({ error: { code: added.code } }, { status: added.status });
      }

      const view = await buildGroupView(db, group);
      const expense = view.expenses.find((item) => item.id === added.value.expenseId);
      // A retry whose expense has since gone answers like any other id that is not in this group.
      if (expense === undefined) return notFound();
      const response: AddExpenseResponse = { expense, group: view };
      return json(response, { status: added.value.status });
    });
  } catch {
    return serverError();
  }
}

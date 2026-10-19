import { connection } from "next/server";
import { withDb } from "@/db/client";
import { changeBaseCurrencyBody, parseBody } from "@/lib/api-schemas";
import type { ChangeBaseCurrencyResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, serverError } from "@/lib/http";
import { changeBaseCurrency } from "@/lib/ledger-store";

/**
 * Reads the group named by the x-penny-group header. Writes nothing.
 * 200 GroupView. 404 not_found, byte for byte the same for a missing, malformed or unknown token.
 * Any other failure is a bare 500.
 */
export async function GET(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      return json(await buildGroupView(db, group));
    });
  } catch {
    return serverError();
  }
}

/**
 * Changes the base currency of the group named by the x-penny-group header. Body: { baseCurrency }, nothing else.
 * 200 { group }, and the same 200 with nothing written when the group already has that base.
 * 400 invalid_body or bad_currency. 404 not_found for an unknown token. 409 base_locked once the group has had any
 * expense or payment, deleted ones included. Any other failure is a bare 500.
 */
export async function PATCH(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, changeBaseCurrencyBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();

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

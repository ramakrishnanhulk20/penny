import { connection } from "next/server";
import { z } from "zod";
import { withDb } from "@/db/client";
import { editExpenseBody, MAX_VERSION, parseBody } from "@/lib/api-schemas";
import type { AddExpenseResponse, DeleteExpenseResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, serverError } from "@/lib/http";
import { deleteExpense, editExpense, type Refusal } from "@/lib/ledger-store";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Checked before any query, because Postgres throws on a string it cannot read as a uuid. Covers the shape of the
// id only; whether it is an expense of this group is the store's question.
const EXPENSE_ID = z.uuid();

// ASCII digits only, no sign, no leading zero, at most ten of them, so Number() below is exact. Rules out "1e3",
// " 1", "+1", "0x1" and "1.0", which Number() alone would read as numbers.
const VERSION_DIGITS = /^[1-9][0-9]{0,9}$/;

type Params = { params: Promise<{ expenseId: string }> };

// Exactly one ?version=, as a positive whole number the version column can hold. Anything else is null.
function versionFrom(request: Request): number | null {
  const values = new URL(request.url).searchParams.getAll("version");
  if (values.length !== 1 || !VERSION_DIGITS.test(values[0])) return null;
  const version = Number(values[0]);
  return version <= MAX_VERSION ? version : null;
}

function refused(refusal: Refusal): Response {
  if (refusal.status === 404) return notFound();
  if (refusal.status === 400) return badRequest(refusal.code);
  return json({ error: { code: refusal.code } }, { status: refusal.status });
}

/**
 * Edits one expense of the group named by the x-penny-group header, from the version the editor saw.
 * 200 { expense, group } once edited, and the same 200 with nothing written when this exact edit already brought
 * the expense to version + 1 (a retry).
 * 400 with the codes adding an expense uses, or invalid_body for a body that is not exactly the edit shape.
 * 404 not_found, byte for byte the same, for an unknown token, an id that is not a uuid, an expense of another group,
 * a deleted expense, or any member id outside this group. 409 stale_version when the version is not the current one.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * Any other failure is a bare 500.
 */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    // Counted on a short connection of its own, so the body below is still read with no connection held.
    const allowed = await withDb(async (db) =>
      takeRateLimit(db, LIMITS.groupWritePerNetwork, await networkKey(db, clientNetwork(request.headers))),
    );
    if (!allowed) return tooMany();
    const { expenseId } = await params;
    if (!EXPENSE_ID.safeParse(expenseId).success) return notFound();
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, editExpenseBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const edited = await editExpense(db, group, expenseId, body.value);
      if (!edited.ok) return refused(edited);

      const view = await buildGroupView(db, group);
      const expense = view.expenses.find((item) => item.id === edited.value.expenseId);
      // Deleted by someone else between the edit and this read: it answers like any other expense that is gone.
      if (expense === undefined) return notFound();
      const response: AddExpenseResponse = { expense, group: view };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

/**
 * Deletes one expense of the group named by the x-penny-group header, from the version in ?version=.
 * 200 { group } once deleted, and the same 200 with nothing written when it already was.
 * 400 invalid_body when ?version= is missing, repeated, or not a positive whole number written in plain digits.
 * 404 not_found, byte for byte the same, for an unknown token, an id that is not a uuid, or an expense of another
 * group. 409 stale_version when the version is not the live expense's current one.
 * 429 rate_limited past LIMITS.groupWritePerNetwork from one client network, or past LIMITS.groupWritePerGroup for
 * the group the token names; an unknown token is a 404 first.
 * Any other failure is a bare 500.
 */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.groupWritePerNetwork, network))) return tooMany();
      const { expenseId } = await params;
      if (!EXPENSE_ID.safeParse(expenseId).success) return notFound();
      const version = versionFrom(request);
      if (version === null) return badRequest("invalid_body");
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();
      if (!(await takeRateLimit(db, LIMITS.groupWritePerGroup, group.id))) return tooMany();

      const deleted = await deleteExpense(db, group, expenseId, version);
      if (!deleted.ok) return refused(deleted);

      const response: DeleteExpenseResponse = { group: await buildGroupView(db, group) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

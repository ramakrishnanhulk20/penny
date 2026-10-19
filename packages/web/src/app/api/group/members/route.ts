import { connection } from "next/server";
import { withDb } from "@/db/client";
import { addMemberBody, parseBody } from "@/lib/api-schemas";
import type { AddMemberResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { badRequest, json, notFound, serverError } from "@/lib/http";
import { addMember } from "@/lib/ledger-store";

/**
 * Adds a member to the group named by the x-penny-group header. Body: { name }, nothing else.
 * 201 { member, group }.
 * 400 invalid_body, bad_member_name (empty, over 40 characters, or holding a control or format character) or
 * duplicate_member_name (a current member has the same name, letter case and Unicode form ignored).
 * 404 not_found for an unknown token. 409 too_many_members once the group has 20 members. Any other failure is a
 * bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    // The body is read before a database connection is opened, so a slow sender cannot hold one.
    const body = await parseBody(request, addMemberBody);
    if (!body.ok) return badRequest(body.code);
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();

      const added = await addMember(db, group, body.value);
      if (!added.ok) {
        if (added.status === 404) return notFound();
        if (added.status === 400) return badRequest(added.code);
        return json({ error: { code: added.code } }, { status: added.status });
      }

      const view = await buildGroupView(db, group);
      const member = view.members.find((item) => item.id === added.value.memberId);
      // Removed by someone else between the add and this read: it answers like any other member that is gone.
      if (member === undefined) return notFound();
      const response: AddMemberResponse = { member, group: view };
      return json(response, { status: 201 });
    });
  } catch {
    return serverError();
  }
}

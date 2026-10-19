import { connection } from "next/server";
import { z } from "zod";
import { withDb } from "@/db/client";
import type { RemoveMemberResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { json, notFound, serverError } from "@/lib/http";
import { removeMember } from "@/lib/ledger-store";

// Checked before any query, because Postgres throws on a string it cannot read as a uuid. Covers the shape of the
// id only; whether it is a member of this group is the store's question.
const MEMBER_ID = z.uuid();

/**
 * Removes one member of the group named by the x-penny-group header. Their row and history stay; they leave the
 * member list and every picker.
 * 200 { group } once removed, and the same 200 with nothing written when they already were.
 * 404 not_found, byte for byte the same, for an unknown token, an id that is not a uuid, or a member of another
 * group. 409 member_in_use for a member named in any expense or payment, deleted ones included, or with a non-zero
 * balance; 409 too_few_members when only two members are left. Any other failure is a bare 500.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ memberId: string }> }): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    const { memberId } = await params;
    if (!MEMBER_ID.safeParse(memberId).success) return notFound();
    return await withDb(async (db) => {
      const group = await resolveGroup(db, request.headers.get(GROUP_TOKEN_HEADER));
      if (group === null) return notFound();

      const removed = await removeMember(db, group, memberId);
      if (!removed.ok) {
        if (removed.status === 404) return notFound();
        return json({ error: { code: removed.code } }, { status: removed.status });
      }

      const response: RemoveMemberResponse = { group: await buildGroupView(db, group) };
      return json(response);
    });
  } catch {
    return serverError();
  }
}

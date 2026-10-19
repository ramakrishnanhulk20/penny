import { connection } from "next/server";
import { withDb } from "@/db/client";
import { buildGroupView } from "@/lib/group-view";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { json, notFound, serverError } from "@/lib/http";

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

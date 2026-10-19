import { connection } from "next/server";
import { withDb } from "@/db/client";
import type { CreateGroupResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { json, serverError } from "@/lib/http";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";
import { createSampleTrip } from "@/lib/sample-trip";

/**
 * Makes a brand-new sample trip group and returns its link, exactly as POST /api/groups returns a new group.
 * Takes no input: the body and query are never read, so nothing a caller sends can change what is made.
 * 201 { token, group }: the token is the new group's link secret and is returned only here. 429 rate_limited past
 * LIMITS.sampleTrip from one client network. Any other failure is a bare 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.sampleTrip, network))) return tooMany();
      const created = await createSampleTrip(db);
      const response: CreateGroupResponse = {
        token: created.token,
        group: await buildGroupView(db, created.group),
      };
      return json(response, { status: 201 });
    });
  } catch {
    return serverError();
  }
}

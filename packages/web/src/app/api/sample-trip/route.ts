import { connection } from "next/server";
import { withDb } from "@/db/client";
import type { CreateGroupResponse } from "@/lib/api-types";
import { buildGroupView } from "@/lib/group-view";
import { declaresJson, json, serverError, unsupportedMediaType } from "@/lib/http";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";
import { createSampleTrip } from "@/lib/sample-trip";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

/**
 * Makes a brand-new sample trip group and returns its link, exactly as POST /api/groups returns a new group.
 * Takes no input: the body and query are never read, so nothing a caller sends can change what is made. It still
 * needs Content-Type: application/json, body or not.
 * 201 { token, group }: the token is the new group's link secret and is returned only here. 415 unsupported_media_type
 * without that header. 429 rate_limited past LIMITS.sampleTrip from one client network. Any other failure is a bare
 * 500.
 */
export async function POST(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 500.
  await connection();
  // The header is the only thing this route checks. Another site can send a bodiless POST without asking first, but
  // not one declared JSON, so this keeps other sites from making groups through a visitor's browser.
  if (!declaresJson(request)) return unsupportedMediaType();
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

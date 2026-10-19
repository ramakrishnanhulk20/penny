import { connection } from "next/server";
import { withDb } from "@/db/client";
import { fetchSnapshot, readSnapshot } from "@/lib/checks";
import { json } from "@/lib/http";

/**
 * How Penny is tested, read from GitHub: the running commit and the TestSprite verdict on each recent pull request.
 * Takes no input at all. No query, body or header changes what is fetched (threat model C21).
 * 200 ChecksSnapshot; when GitHub did not answer, the last good read with stale: true.
 * 503 {"error":{"code":"unavailable"}} when there is no good read to show, with no detail of why.
 */
export async function GET(): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 503.
  await connection();
  try {
    // Server only, never a NEXT_PUBLIC_ variable. Without it GitHub is read anonymously, as for any visitor (C24).
    const token = process.env.GITHUB_READ_TOKEN?.trim() || null;
    const snapshot = await withDb((db) => readSnapshot(db, new Date(), () => fetchSnapshot(fetch, token)));
    return json(snapshot);
  } catch {
    return json({ error: { code: "unavailable" } }, { status: 503 });
  }
}

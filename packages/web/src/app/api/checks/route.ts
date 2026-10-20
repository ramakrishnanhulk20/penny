import { connection } from "next/server";
import { withDb } from "@/db/client";
import { fetchSnapshot, readSnapshot } from "@/lib/checks";
import { json } from "@/lib/http";
import { LIMITS, clientNetwork, networkKey, takeRateLimit, tooMany } from "@/lib/rate-limit";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

/**
 * How Penny is tested, read from GitHub: the running commit and the TestSprite verdict on each recent pull request.
 * Takes no input that changes what is fetched: no query, body or header does (threat model C21). The client address
 * only counts against LIMITS.groupRead.
 * 200 ChecksSnapshot; when GitHub did not answer, the last good read with stale: true.
 * 429 rate_limited past LIMITS.groupRead from one client network.
 * 503 {"error":{"code":"unavailable"}} when there is no good read to show, with no detail of why.
 */
export async function GET(request: Request): Promise<Response> {
  // Outside the try: during a build this throws on purpose to mark the route dynamic, and must not become a 503.
  await connection();
  try {
    return await withDb(async (db) => {
      const network = await networkKey(db, clientNetwork(request.headers));
      if (!(await takeRateLimit(db, LIMITS.groupRead, network))) return tooMany();
      // Server only, never a NEXT_PUBLIC_ variable. Without it GitHub is read anonymously, as for any visitor (C24).
      const token = process.env.GITHUB_READ_TOKEN?.trim() || null;
      return json(await readSnapshot(db, new Date(), () => fetchSnapshot(fetch, token)));
    });
  } catch {
    return json({ error: { code: "unavailable" } }, { status: 503 });
  }
}

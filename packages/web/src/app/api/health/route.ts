import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { withDb } from "@/db/client";
import { json } from "@/lib/http";

// Vercel stops this function after 10 s, so a stuck database or upstream call cannot hold it open (threat model C26).
export const maxDuration = 10;

// This route has no rate limit, so each instance asks the database at most once in this window, however many callers
// arrive, and concurrent callers share the one check in flight.
const CHECK_EVERY_MS = 10_000;

let lastCheck: { readonly at: number; readonly up: Promise<boolean> } | null = null;

async function databaseAnswers(): Promise<boolean> {
  try {
    await withDb((db) => db.execute(sql`select 1`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 200 {"status":"up"} when the database answers `select 1`, else 503 {"status":"down"}. The answer, up or down, is
 * reused for 10 s on this instance; a check stamped in the future (a clock set back) counts as expired.
 * The body never says why it is down: no error text, host or connection detail.
 */
export async function GET(): Promise<Response> {
  // Without this, a build with no database answers 503 in a microtask and Next freezes that answer as a static file.
  await connection();
  const now = Date.now();
  const age = lastCheck === null ? -1 : now - lastCheck.at;
  if (lastCheck === null || age < 0 || age >= CHECK_EVERY_MS) lastCheck = { at: now, up: databaseAnswers() };
  return (await lastCheck.up) ? json({ status: "up" }) : json({ status: "down" }, { status: 503 });
}

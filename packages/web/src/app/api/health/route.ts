import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { withDb } from "@/db/client";
import { json } from "@/lib/http";

/**
 * 200 {"status":"up"} when the database answers `select 1`, else 503 {"status":"down"}.
 * The body never says why it is down: no error text, host or connection detail.
 */
export async function GET(): Promise<Response> {
  // Without this, a build with no database answers 503 in a microtask and Next freezes that answer as a static file.
  await connection();
  try {
    await withDb((db) => db.execute(sql`select 1`));
    return json({ status: "up" });
  } catch {
    return json({ status: "down" }, { status: 503 });
  }
}

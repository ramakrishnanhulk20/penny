import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { groups, type GroupRow } from "../db/schema";
import { hashGroupToken, parseGroupToken } from "./group-token";

/**
 * The one way a link token becomes a group. Every route, page render and server action goes through here.
 * A malformed token returns null before the database is touched; an unknown one returns null after one lookup.
 */
export async function resolveGroup(db: Db, rawToken: string | null | undefined): Promise<GroupRow | null> {
  const token = parseGroupToken(rawToken);
  if (token === null) return null;

  const rows = await db
    .select()
    .from(groups)
    .where(eq(groups.tokenHash, hashGroupToken(token)))
    .limit(1);
  return rows[0] ?? null;
}

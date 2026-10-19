import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { groups, type GroupRow } from "../db/schema";
import { hashGroupToken, mintGroupToken, parseGroupToken } from "./group-token";

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

/**
 * Gives the group a new link token from mintGroupToken and returns it. Only the new token's hash is stored, in place
 * of the old one, so once this commits the old token resolves to nothing. The token itself is never stored or logged.
 * Run it inside the transaction that records the reset. Throws if no group has this id.
 */
export async function rotateGroupToken(db: Db, groupId: string): Promise<string> {
  const { token, hash } = mintGroupToken();
  const updated = await db
    .update(groups)
    .set({ tokenHash: hash })
    .where(eq(groups.id, groupId))
    .returning({ id: groups.id });
  if (updated.length !== 1) throw new Error("group_missing");
  return token;
}

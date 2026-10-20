import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.int().nonnegative(), when: z.int().positive(), tag: z.string().min(1) })),
});

// Postgres sends a bigint column as text through node-postgres and Neon; PGlite may send a number or a bigint.
const appliedSchema = z.object({
  rows: z.array(z.object({ created_at: z.union([z.string().regex(/^[0-9]+$/), z.int().nonnegative(), z.bigint()]) })),
});

export type JournalEntry = { readonly idx: number; readonly when: number; readonly tag: string };

/** Every migration drizzle-kit wrote into `migrationsFolder`, from its meta/_journal.json. Throws on any other shape. */
export function readJournal(migrationsFolder: string): JournalEntry[] {
  const text = readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8");
  return journalSchema.parse(JSON.parse(text)).entries;
}

/**
 * Throws, naming every one, when a migration in the journal has no row in drizzle.__drizzle_migrations. Run right
 * after migrate(): drizzle's migrator only runs a file whose journal `when` is later than the newest migration already
 * applied, so one written on a branch before another branch's migration landed is skipped without a word. Matched on
 * `when`, which drizzle stores as created_at for each file it runs. Covers skipped files; it does not compare file
 * contents, so a migration edited after it ran still passes.
 */
export async function assertEveryMigrationApplied(
  db: { execute(query: SQL): PromiseLike<unknown> },
  migrationsFolder: string,
): Promise<void> {
  const journal = readJournal(migrationsFolder);
  const applied = appliedSchema.parse(await db.execute(sql`select created_at from drizzle.__drizzle_migrations`));
  const done = new Set(applied.rows.map((row) => BigInt(row.created_at)));
  const missing = journal.filter((entry) => !done.has(BigInt(entry.when))).map((entry) => entry.tag);
  if (missing.length > 0) {
    throw new Error(
      `these migrations in drizzle/meta/_journal.json were never applied: ${missing.join(", ")}. Each needs a "when" ` +
        "later than every migration already applied; regenerate it on top of the current main.",
    );
  }
}

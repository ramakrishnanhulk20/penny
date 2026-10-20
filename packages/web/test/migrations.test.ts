// Not covered: the guard running against Neon through scripts/migrate.ts (the same check over drizzle-orm's
// neon-serverless driver, which stores created_at the same way; read in drizzle-orm's pg-core dialect, not run here),
// two builds migrating one database at once, and a migration edited after it ran (the guard matches on `when` only).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { assertEveryMigrationApplied, readJournal } from "@/db/migration-check";

const REPO_MIGRATIONS = join(__dirname, "..", "drizzle");
const scratch = mkdtempSync(join(tmpdir(), "penny-migrations-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the migration guard", () => {
  it("passes once every migration in the repo has run, run once or twice", async () => {
    const db = drizzle({ client: new PGlite() });
    await migrate(db, { migrationsFolder: REPO_MIGRATIONS });
    await expect(assertEveryMigrationApplied(db, REPO_MIGRATIONS)).resolves.toBeUndefined();

    await migrate(db, { migrationsFolder: REPO_MIGRATIONS });
    await expect(assertEveryMigrationApplied(db, REPO_MIGRATIONS)).resolves.toBeUndefined();
  });

  it("throws, naming it, for a migration dated before the newest applied one, which drizzle skips without a word", async () => {
    const folder = join(scratch, "late-branch");
    cpSync(REPO_MIGRATIONS, folder, { recursive: true });
    const db = drizzle({ client: new PGlite() });
    await migrate(db, { migrationsFolder: folder });

    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Record<string, unknown>[] };
    const newest = readJournal(folder).at(-1);
    if (newest === undefined) throw new Error("the repo has no migrations");
    // Written on a branch made before the newest migration landed, so drizzle-kit dated it earlier.
    const late = { idx: newest.idx + 1, when: newest.when - 1, tag: "9999_late_branch" };
    journal.entries.push({ ...journal.entries.at(-1), ...late });
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(join(folder, "9999_late_branch.sql"), 'ALTER TABLE "groups" ADD COLUMN "late_column" text;');

    await migrate(db, { migrationsFolder: folder });
    const added = await db.execute(
      "select 1 from information_schema.columns where table_name = 'groups' and column_name = 'late_column'",
    );
    expect(added.rows).toEqual([]);
    await expect(assertEveryMigrationApplied(db, folder)).rejects.toThrow(/never applied: 9999_late_branch\./);
  });

  it("throws, naming each, when the database has not run the repo's migrations at all", async () => {
    const db = drizzle({ client: new PGlite() });
    // The bookkeeping table as drizzle's migrator makes it, with no migration run yet.
    await db.execute("create schema drizzle");
    await db.execute(
      "create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
    );

    await expect(assertEveryMigrationApplied(db, REPO_MIGRATIONS)).rejects.toThrow(
      new RegExp(`never applied: ${readJournal(REPO_MIGRATIONS).map((entry) => entry.tag).join(", ")}\\.`),
    );
  });
});

describe("the journal", () => {
  it("lists its migrations by idx 0, 1, 2... with every `when` later than the one before", () => {
    const entries = readJournal(REPO_MIGRATIONS);

    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_entry, index) => index));
    for (let i = 1; i < entries.length; i += 1) {
      expect([entries[i].tag, entries[i].when > entries[i - 1].when]).toEqual([entries[i].tag, true]);
    }
  });
});

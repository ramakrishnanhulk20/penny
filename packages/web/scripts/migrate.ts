import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { assertEveryMigrationApplied } from "../src/db/migration-check";
import { serverEnv } from "../src/lib/env";

// Runs before every `next build`, so the schema only ever changes through migration files committed to the repo.
// On Vercel each environment's DATABASE_URL points at its own Neon branch, so a preview build migrates only its branch.

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    if (process.env.VERCEL) {
      console.error(
        "migrate: DATABASE_URL is not set for this Vercel environment. Connect the Neon integration to this environment, then redeploy.",
      );
      return 1;
    }
    if (process.env.SKIP_MIGRATE === "1") {
      console.log("migrate: skipped, SKIP_MIGRATE=1 and no DATABASE_URL set");
      return 0;
    }
    console.error("migrate: DATABASE_URL is not set. Set it, or set SKIP_MIGRATE=1 to build without migrating.");
    return 1;
  }

  const pool = new Pool({ connectionString: serverEnv().DATABASE_URL });
  try {
    const db = drizzle({ client: pool });
    await migrate(db, { migrationsFolder });
    // The migrator skips a file dated before the newest one applied and reports success; the build stops here instead.
    await assertEveryMigrationApplied(db, migrationsFolder);
  } finally {
    await pool.end();
  }
  console.log("migrate: database schema is up to date");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Build logs are read by people who should not see the password inside the connection string.
    const url = process.env.DATABASE_URL;
    console.error(`migrate: failed: ${url ? message.split(url).join("[DATABASE_URL]") : message}`);
    process.exitCode = 1;
  },
);

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client";
import * as schema from "./schema";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** A fresh in-memory Postgres with every migration in ./drizzle applied. Test code only. */
export async function createTestDb(): Promise<Db> {
  const db = drizzle({ client: new PGlite(), schema });
  await migrate(db, { migrationsFolder });
  return db;
}

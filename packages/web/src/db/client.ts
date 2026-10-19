import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { serverEnv } from "../lib/env";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let testDb: Db | null = null;

/**
 * Points every later withDb call at the given database, or back at Neon with null.
 * Throws in production so it can never become a way around the real database.
 */
export function setDbForTests(db: Db | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setDbForTests is not available in production");
  }
  testDb = db;
}

/**
 * Runs fn against the database and always releases the connection afterwards.
 * Throws if DATABASE_URL is missing or invalid, or if fn throws.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (testDb) return fn(testDb);

  // Neon's WebSocket connections cannot outlive one serverless request, so the pool is per call.
  // Fail closed on a slow or stuck database (threat model C26): no request waits on it longer than these.
  const pool = new Pool({
    connectionString: serverEnv().DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  // An idle connection dropping emits "error" on the pool; unhandled, that would crash the function.
  pool.on("error", () => {});
  try {
    return await fn(drizzle({ client: pool, schema }));
  } finally {
    await pool.end();
  }
}

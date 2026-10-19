// Not covered: that every route and page really calls resolveGroup, response timing, or the Neon driver (this runs on in-memory PGlite).
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { groups } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { mintGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";

// Any property read on this object fails the test, so reaching it at all counts as touching the database.
function untouchableDb(touched: string[]): Db {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop));
        throw new Error("the database was touched");
      },
    },
  ) as Db;
}

describe("resolveGroup", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("finds a group by its token, which is stored only as its hash", async () => {
    const { token, hash } = mintGroupToken();
    const [created] = await db
      .insert(groups)
      .values({ tokenHash: hash, name: "Lisbon trip", baseCurrency: "EUR" })
      .returning();

    const found = await resolveGroup(db, token);

    expect(found?.id).toBe(created.id);
    expect(found?.tokenHash).toBe(hash);
    expect(found?.tokenHash).not.toBe(token);
  });

  it("returns null for a well-formed token nobody minted into this database", async () => {
    expect(await resolveGroup(db, mintGroupToken().token)).toBeNull();
  });

  it("returns null for a malformed token without issuing any query", async () => {
    const touched: string[] = [];
    const db = untouchableDb(touched);
    const good = mintGroupToken().token;
    const malformed = [null, undefined, "", good.slice(1), `${good}A`, `${good.slice(1)}+`, ` ${good.slice(1)}`, "../../etc"];

    for (const raw of malformed) {
      expect(await resolveGroup(db, raw)).toBeNull();
    }
    expect(touched).toEqual([]);
  });

  it("does reach the database for a well-formed token, so the check above can catch a query", async () => {
    const touched: string[] = [];
    await expect(resolveGroup(untouchableDb(touched), mintGroupToken().token)).rejects.toThrow(
      "the database was touched",
    );
    expect(touched.length).toBeGreaterThan(0);
  });
});

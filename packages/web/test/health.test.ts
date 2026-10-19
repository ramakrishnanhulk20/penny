// Not covered: a real Neon connection, or that Next serves this route at request time (the build route table shows that).
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { type Db, setDbForTests } from "@/db/client";
import { createTestDb } from "@/db/testing";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

afterEach(() => {
  setDbForTests(null);
});

describe("GET /api/health", () => {
  it('returns 200 {"status":"up"} when the database answers', async () => {
    setDbForTests(await createTestDb());

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"up"}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it('returns 503 {"status":"down"} and nothing else when the query throws', async () => {
    const broken = {
      execute: () => Promise.reject(new Error("connect ECONNREFUSED postgres://penny:hunter2@db.internal:5432/penny")),
    } as unknown as Db;
    setDbForTests(broken);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"down"}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

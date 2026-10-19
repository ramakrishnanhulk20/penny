import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every file starts its own in-process Postgres; with all files in parallel that start-up alone can pass 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

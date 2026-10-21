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
    // Vitest starts one worker per core by default, and each one boots Postgres at the same moment. On a 20-core
    // Windows machine that crowding made the suite fail; four workers passed there and keep a laptop just as fast.
    maxWorkers: 4,
  },
});

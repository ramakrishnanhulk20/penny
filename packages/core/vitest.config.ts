import { defineConfig } from "vitest/config";

// Tests stay at the top level, with no describe blocks. StrykerJS 10's vitest runner
// picks the tests to run for each mutant by the name "group test", while vitest 5
// names nested tests "group > test", so a nested test would silently never run
// against any mutant and every mutant it should kill would survive.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/currencies.generated.ts", "src/index.ts"],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
});

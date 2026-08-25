import { defineConfig } from "vitest/config";

/** Long-running cross-checks. `npm run test:slow`. Minutes, not seconds. */
export default defineConfig({
  test: {
    include: ["**/*.slow.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

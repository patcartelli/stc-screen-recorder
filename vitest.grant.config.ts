import { defineConfig } from "vitest/config";

/** Only the tests that need a Screen Recording grant. `npm run test:capture`. */
export default defineConfig({
  test: {
    include: ["**/*.grant.test.ts"],
    testTimeout: 120_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

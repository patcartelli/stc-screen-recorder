import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["transform/test/**/*.test.ts", "helper/test/**/*.test.ts", "app/test/**/*.test.ts"],
    // Needs a Screen Recording grant, which a plain test runner does not have.
    // Green must mean green: a suite that is permanently red trains people to
    // ignore it, and then it protects nothing. Run it with `npm run test:capture`.
    exclude: ["**/node_modules/**", "**/*.grant.test.ts", "**/*.slow.test.ts"],
    testTimeout: 15_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["transform/test/**/*.test.ts", "helper/test/**/*.test.ts", "app/test/**/*.test.ts"],
    testTimeout: 15_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

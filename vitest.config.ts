import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["transform/test/**/*.test.ts"],
  },
});

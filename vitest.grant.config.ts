import { defineConfig } from "vitest/config";

/** Only the tests that need a Screen Recording grant. `npm run test:capture`. */
export default defineConfig({
  test: {
    include: ["**/*.grant.test.ts"],
    // These tests all drive the SAME signed bundle, and macOS runs one instance
    // of an app bundle at a time — so concurrent `open -W` calls collide and one
    // of them silently gets no session at all. Seen on 2026-08-27: the camera
    // capture test reported "no anchors.json — the recording never ran" while
    // the other two grant tests passed in the same run, which read as a missing
    // grant and was not one.
    fileParallelism: false,
    testTimeout: 120_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

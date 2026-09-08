import { defineConfig } from "vitest/config";

/**
 * The tests that cannot run on CI. `npm run test:capture`.
 *
 * Mostly that means a Screen Recording grant. `still-clipboard.grant.test.ts`
 * (STC-293) is the one that does not: it needs a real logged-in Mac session
 * for `NSPasteboard.general`, which a runner cannot be relied on to provide.
 * Same reason to keep it out of `npm test` — a check that reddens on the
 * machine rather than on the code is worse than one that does not run — and
 * the file says so at the top.
 */
export default defineConfig({
  test: {
    // Scoped to the real test directories, exactly as vitest.config.ts scopes
    // its own include. A bare "**/*.grant.test.ts" also globs the agent
    // worktrees under .claude/worktrees/, and those copies resolve
    // tools/test-host/STCTestHost.app relative to their own root, where it does
    // not exist — so the run fails with "build it first" for a bundle that IS
    // built. Seen 2026-08-27: 7 failures, none of them about this checkout.
    include: [
      "transform/test/**/*.grant.test.ts",
      "helper/test/**/*.grant.test.ts",
      "app/test/**/*.grant.test.ts",
    ],
    exclude: ["**/node_modules/**"],
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

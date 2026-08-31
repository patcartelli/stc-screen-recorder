import { defineConfig } from "vitest/config";

/** Long-running cross-checks. `npm run test:slow`. Minutes, not seconds. */
export default defineConfig({
  test: {
    // Scoped to the real test directories, exactly as vitest.config.ts and
    // vitest.grant.config.ts scope theirs. A bare "**/*.slow.test.ts" also globs
    // the agent worktrees under .claude/worktrees/, so `npm run test:slow` ran
    // OTHER checkouts' copies against this one's built helper binary. The grant
    // config was fixed for this on 2026-08-27 and this one was missed — the same
    // defect, one file over.
    //
    // It is not merely noise: it made a mutation test lie. Removing the
    // lock-across-I/O guard from LossyChannel reported "2 failed | 2 passed",
    // and the passes were worktree copies. Evidence gathered through an
    // unscoped glob is evidence about someone else's tree.
    include: [
      "transform/test/**/*.slow.test.ts",
      "helper/test/**/*.slow.test.ts",
      "app/test/**/*.slow.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Under the step's own bound in ci.yml (SLOW_TESTS_MS), so a hung test
    // fails with vitest naming it rather than the step dying anonymously at its
    // cap. 30 minutes per test used to be the value, which three tests could
    // turn into 90 — more than the whole CI job is allowed.
    testTimeout: 480_000,
    hookTimeout: 300_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

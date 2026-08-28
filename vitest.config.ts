import { defineConfig } from "vitest/config";

/**
 * Two projects, because the E2E files need a different concurrency rule than
 * everything else.
 *
 * Measured on master (2026-08-28): a run put SIX Electron apps on the machine
 * at once — five E2E files launching in parallel, each driving a full browser
 * plus the helper. That is enough to starve the box, and the tell is that a
 * loaded run also takes down transform/test/schema.test.ts (pure JSON-schema
 * validation, no Electron, no subprocess) and `spawnSync xcrun ETIMEDOUT`. The
 * E2E tests are not broken; they are simply the most timing-sensitive things
 * running, so they fail first and look like the culprits.
 *
 * vitest.grant.config.ts already reached the same conclusion for the same
 * reason — see its comment about concurrent `open -W` on one app bundle.
 *
 * `fileParallelism` is a per-project option here, NOT the root default: the
 * unit and helper suites are fast and independent, and serialising them would
 * cost minutes for nothing.
 */
const EXCLUDE = ["**/node_modules/**", "**/*.grant.test.ts", "**/*.slow.test.ts"];

export default defineConfig({
  test: {
    // Needs a Screen Recording grant, which a plain test runner does not have.
    // Green must mean green: a suite that is permanently red trains people to
    // ignore it, and then it protects nothing. Run it with `npm run test:capture`.
    exclude: EXCLUDE,
    globalSetup: ["./vitest.global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["transform/test/**/*.test.ts", "helper/test/**/*.test.ts", "app/test/**/*.test.ts"],
          exclude: [...EXCLUDE, "**/*.e2e.test.ts"],
          testTimeout: 15_000,
        },
      },
      {
        // One Electron app on the machine at a time.
        test: {
          name: "e2e",
          include: ["app/test/**/*.e2e.test.ts"],
          exclude: EXCLUDE,
          fileParallelism: false,
          testTimeout: 15_000,
        },
      },
    ],
  },
});

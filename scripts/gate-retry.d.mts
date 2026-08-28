/**
 * Types for `gate-retry.mjs`. The runner is invoked directly by node
 * (`npm run gate`), so the module itself stays JavaScript — this is the seam
 * that lets the TS side see it. Two files that must be widened together, so
 * transform/test/gate-retry.test.ts asserts at RUNTIME that every name declared
 * here exists in the module.
 */
export declare const ATTEMPTS: number;
export declare const ATTEMPT_MS: number;

export declare function isEnvironmentFailure(
  output: string,
  opts?: { signal?: NodeJS.Signals | null },
): boolean;

export declare function announceSkip(
  detail: string,
  opts?: { write?: (s: string) => void },
): string;

export declare function runWithRetry(
  cmd: string,
  args: string[],
  opts?: { attempts?: number; attemptMs?: number; attemptLog?: string },
): Promise<number>;

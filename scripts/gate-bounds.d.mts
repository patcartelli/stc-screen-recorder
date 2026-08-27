/**
 * Types for `gate-bounds.mjs`. The gates are run directly by node
 * (`node scripts/gate.mjs`), so the module itself must stay JavaScript — this
 * is the seam that lets the TS side see it.
 *
 * Two files that must be widened together are how STC-262 happened, so
 * `transform/test/gate-bounds.test.ts` asserts at RUNTIME that every name
 * declared here actually exists in the module.
 */
export declare const EVAL_MS: number;
export declare const TEARDOWN_MS: number;
export declare const EVAL_SLOTS: number;
export declare const SEEK_MS: number;
export declare const PRE_GATE_BUDGET_MS: number;

export declare function bounded<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T>;
export declare function closeQuietly(
  browser: { close(): Promise<unknown> } | undefined,
  server: { close(): Promise<unknown> } | undefined,
): Promise<void>;

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
export declare const ENCODER_MS: number;
export declare const TEARDOWN_MS: number;
export declare const EVAL_SLOTS: number;
export declare const SEEK_MS: number;
export declare const PRE_GATE_BUDGET_MS: number;
export declare const LAUNCH_MS: number;
export declare const READY_MS: number;
export declare const FLOOR_MARGIN: number;

export declare const ATTEMPTS: number;
export declare const ATTEMPT_MS: number;
export declare const GC_RETRIES: number;
export declare const GATE_PROCESS_MS: Record<string, number>;
export declare const GATE_ATTEMPTS: Record<string, number>;
export declare function gateFloorMs(script: string): number;
/**
 * `attempts` overrides GATE_ATTEMPTS so the clearance test can assert the model
 * MOVES with the retry count instead of multiplying whatever the count happens
 * to be — a distinction that stopped being academic when ATTEMPTS dropped to 1.
 */
export declare function worstCaseJobMs(
  opts?: { attempts?: Record<string, number> },
): number;
export declare function attemptFloorMs(): number;

export declare function bounded<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T>;
export declare function isBoundFailure(e: unknown): boolean;

export declare function closeQuietly(
  browser: { close(): Promise<unknown> } | undefined,
  server: { close(): Promise<unknown> } | undefined,
): Promise<void>;

import { describe, test, expect } from "vitest";
import { withTimeout, TimeoutError } from "../src/timeout.js";

describe("withTimeout", () => {
  test("passes through a value that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "quick")).resolves.toBe(42);
  });

  test("passes through a rejection unchanged — it must not mask real errors", async () => {
    const boom = new Error("the actual problem");
    await expect(withTimeout(Promise.reject(boom), 1000, "quick")).rejects.toBe(boom);
  });

  test("rejects with what was being waited on, not a bare 'timeout'", async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 30, "decoder flush")).rejects.toThrow(/decoder flush/);
    await expect(withTimeout(never, 30, "decoder flush")).rejects.toThrow(TimeoutError);
  });

  test("names the elapsed budget, so the number is not a mystery", async () => {
    await expect(withTimeout(new Promise(() => {}), 30, "x")).rejects.toThrow(/30\s?ms/);
  });

  test("does not hold the process open after the wrapped promise settles", async () => {
    // A timer left armed keeps node (and an Electron renderer) alive; the timer
    // must be cleared on the happy path, not only on the timeout path.
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    await withTimeout(Promise.resolve("done"), 60_000, "long budget");
    const after = (process as any)._getActiveHandles?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});

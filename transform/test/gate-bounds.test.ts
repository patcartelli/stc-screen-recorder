import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bounded, EVAL_MS, EVAL_SLOTS, SEEK_MS, PRE_GATE_BUDGET_MS,
} from "../../scripts/gate-bounds.mjs";
import * as bounds from "../../scripts/gate-bounds.mjs";

const root = join(__dirname, "..", "..");

describe("gate bounds — the bound itself", () => {
  test("a promise that never settles is rejected, by name", async () => {
    // A bound nobody has watched fire is indistinguishable from one that
    // cannot fire. This is that watching, in the cheapest possible form.
    const never = new Promise(() => {});
    await expect(bounded(never, 20, "the in-page gate run")).rejects.toThrow(
      "the in-page gate run did not return within 20 ms",
    );
  });

  test("a promise that settles in time passes its value through", async () => {
    await expect(bounded(Promise.resolve("ok"), 5_000, "x")).resolves.toBe("ok");
  });

  test("a real rejection is not disguised as a timeout", async () => {
    // The message matters: a bound that relabels every failure as "timed out"
    // sends the next person looking at the clock instead of at the error.
    await expect(bounded(Promise.reject(new Error("decoder said no")), 5_000, "x"))
      .rejects.toThrow("decoder said no");
  });
});

describe("gate bounds — the .d.mts stays in step with the module", () => {
  test("every name the declaration file promises exists at runtime", () => {
    // A hand-written .d.mts is a second file that must be widened with the
    // first — exactly the shape of STC-262. tsc checks the declaration; only
    // this checks that the declaration is not describing a module that moved.
    const declared = readFileSync(join(root, "scripts", "gate-bounds.d.mts"), "utf8")
      .match(/export declare (?:const|function) (\w+)/g)!
      .map((m) => m.split(" ").pop()!);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(bounds, `gate-bounds.d.mts declares ${name}, the module does not export it`)
        .toHaveProperty(name);
    }
  });
});

describe("gate bounds — clearance against the CI job timeout", () => {
  test("the gates' bounds sum to less than the job cap, with margin", () => {
    // Kept honest against the workflow rather than against this comment. An
    // inner bound at or above the outer one loses the race, and the job
    // timeout — which reports as "cancelled" — wins with no explanation.
    // writer-gate already made exactly that mistake once.
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const m = ci.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m);
    expect(m, "ci.yml must declare timeout-minutes for this clearance to mean anything").not.toBeNull();

    const jobCapMs = Number(m![1]) * 60_000;
    const worstCaseMs = PRE_GATE_BUDGET_MS + EVAL_SLOTS * EVAL_MS + SEEK_MS;
    const marginMs = jobCapMs - worstCaseMs;

    expect(worstCaseMs).toBeLessThan(jobCapMs);
    // Not a token margin: the gates must be able to time out and still leave
    // room to print why and upload the artifacts.
    expect(marginMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test("every bounded evaluate in the CI gates is accounted for", () => {
    // EVAL_SLOTS is arithmetic, so it silently rots when a gate gains an
    // evaluate. Count them in the source instead of trusting the constant.
    const files = ["gate.mjs", "export-gate.mjs", "identity-gate.mjs"];
    const found = files
      .map((f) => readFileSync(join(root, "scripts", f), "utf8"))
      .join("\n")
      .match(/bounded\(\s*page\.evaluate/g) ?? [];
    expect(found.length).toBe(EVAL_SLOTS - 1);   // export-gate's one call site runs twice
  });

  test("no gate still calls page.evaluate unbounded", () => {
    for (const f of ["gate.mjs", "export-gate.mjs", "identity-gate.mjs", "seek-gate.mjs"]) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      for (const line of src.split("\n")) {
        if (!line.includes("page.evaluate")) continue;
        // Either wrapped by our helper, or inside seek-gate's own Promise.race.
        const guarded = /bounded\(\s*page\.evaluate/.test(line) || /Promise\.race/.test(src);
        expect(guarded, `${f}: unbounded page.evaluate -> ${line.trim()}`).toBe(true);
      }
    }
  });
});

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bounded, EVAL_MS, ENCODER_MS, EVAL_SLOTS, SEEK_MS, PRE_GATE_BUDGET_MS,
  worstCaseJobMs, attemptFloorMs,
} from "../../scripts/gate-bounds.mjs";
import { ATTEMPTS, ATTEMPT_MS } from "../../scripts/gate-retry.mjs";
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

describe("gate teardown is bounded in EVERY gate", () => {
  // Closing a browser whose renderer is wedged NEVER RETURNS, and the gates run
  // in `finally`. STC-259's 26-minute "stall" was exactly this: gate.mjs failed
  // correctly at 66 s, then sat 26 more minutes in browser.close(). A job
  // timeout reports as "cancelled", so the real error scrolled past unread.
  //
  // #30 fixed it in gate.mjs and two others and MISSED seek-gate.mjs, which
  // then did the identical thing on 2026-08-28: failed in 10 s with a full
  // decoder dump, then held the job until the 30-minute cap. This test is here
  // so the next gate cannot be the one that was missed.
  const GATES = ["gate.mjs", "seek-gate.mjs", "export-gate.mjs", "identity-gate.mjs"];

  test("no gate calls browser.close() directly", () => {
    const offenders: string[] = [];
    for (const f of GATES) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/\bbrowser\.close\(/.test(line)) offenders.push(`scripts/${f}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders,
      `an unbounded teardown holds the CI job until its cap and reports as ` +
      `"cancelled", losing the real error:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("every gate tears down through closeQuietly", () => {
    for (const f of GATES) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      expect(src, `scripts/${f} must import closeQuietly from gate-bounds.mjs`)
        .toMatch(/closeQuietly/);
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
    // The model lives with the constants and accounts for the RETRY. The old
    // flat sum (PRE_GATE + EVAL_SLOTS x EVAL_MS + SEEK_MS) said 21.5 min and
    // stayed silent when #39 made the determinism gate alone capable of 30.
    const worstCaseMs = worstCaseJobMs();
    const marginMs = jobCapMs - worstCaseMs;

    expect(worstCaseMs).toBeLessThan(jobCapMs);
    // Not a token margin: the gates must be able to time out and still leave
    // room to print why and upload the artifacts.
    expect(marginMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test("the in-page encoder bound stays under the per-evaluate bound", () => {
    // The harness bounds its own encoder waits with ENCODER_MS, handed in by
    // gate.mjs. If it ever reached EVAL_MS the outer bound would fire first and
    // the specific message — the frame the encoder stopped draining on — would
    // always lose the race. That is the writer-gate mistake, one layer in.
    expect(ENCODER_MS).toBeLessThan(EVAL_MS);
  });

  test("gate.mjs hands the page its bound and checks what came back", () => {
    // The page could quietly use a bound of its own; then both sides believe
    // they agree and the clearance above is asserting about nothing.
    const src = readFileSync(join(root, "scripts", "gate.mjs"), "utf8");
    expect(src, "gate.mjs must pass ENCODER_MS into runGate")
      .toMatch(/runGate\(\s*\{\s*encoderMs:/);
    expect(src, "gate.mjs must assert the bound the page reports back")
      .toMatch(/encoderBoundMs\s*!==\s*ENCODER_MS/);
  });

  test("one attempt's bound clears what an attempt legitimately costs", () => {
    // If ATTEMPT_MS is below the floor, gate-retry's own bound fires before the
    // gate can print `ENVIRONMENT:` — and isEnvironmentFailure() then correctly
    // refuses to retry it, so the retry silently stops working. Same shape as
    // an inner bound set equal to the outer one.
    expect(ATTEMPT_MS).toBeGreaterThan(attemptFloorMs());
  });

  test("the retry is part of the worst case, not sitting outside it", () => {
    // Guards the specific regression: a model that ignores ATTEMPTS would not
    // move when the retry count does.
    expect(worstCaseJobMs()).toBeGreaterThanOrEqual(ATTEMPTS * ATTEMPT_MS);
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
    // The exemption is NAMED, and matched against the statement rather than the
    // file. Testing `Promise.race` against the whole source made any file that
    // contained one anywhere exempt for every page.evaluate in it, including an
    // unbounded one added later — a guard passing by finding something
    // unrelated, which is the shape this whole PR exists to remove. Caught in
    // review by the session on PR #31.
    const SELF_BOUNDED = new Set(["seek-gate.mjs"]);   // its own race, same statement, better message
    for (const f of ["gate.mjs", "export-gate.mjs", "identity-gate.mjs", "seek-gate.mjs"]) {
      const lines = readFileSync(join(root, "scripts", f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("page.evaluate")) return;
        // The call and its wrapper can straddle a line break; nothing wider.
        const stmt = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        const guarded = /bounded\(\s*page\.evaluate/.test(stmt)
          || (SELF_BOUNDED.has(f) && /Promise\.race\(\[/.test(stmt));
        expect(guarded, `${f}:${i + 1} unbounded page.evaluate -> ${line.trim()}`).toBe(true);
      });
    }
  });
});

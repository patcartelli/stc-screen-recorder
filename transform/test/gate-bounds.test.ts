import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import {
  bounded, EVAL_MS, ENCODER_MS, EVAL_SLOTS, SEEK_MS, PRE_GATE_BUDGET_MS,
  worstCaseJobMs, attemptFloorMs, FLOOR_MARGIN, READY_MS, LAUNCH_MS, TEARDOWN_MS,
  GATE_PROCESS_MS, GATE_ATTEMPTS, gateFloorMs, GC_RETRIES, SLOW_TESTS_MS,
} from "../../scripts/gate-bounds.mjs";
import { ATTEMPTS, ATTEMPT_MS } from "../../scripts/gate-retry.mjs";
import * as bounds from "../../scripts/gate-bounds.mjs";
import { isEnvironmentFailure } from "../../scripts/gate-retry.mjs";

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
  // The peer's ask, and the case that makes the whole skip safe: a gate that
  // stalls on the machine AND separately finds a wrong answer must stay RED.
  // With (b) there are now four producers of the ENVIRONMENT label instead of
  // one, so this is the assertion standing between "skip a machine fault" and
  // "skip a regression that happened to co-occur with one".
  test("a run that prints BOTH ENVIRONMENT and FAIL: is never skippable", () => {
    const both =
      "ENVIRONMENT: the decoder accepted chunks and emitted none\n" +
      "FAIL: 3 seeks returned the wrong frame\n";
    expect(isEnvironmentFailure(both),
      "a regression co-occurring with a machine fault must stay red").toBe(false);
    // And each alone still classifies as before.
    expect(isEnvironmentFailure("ENVIRONMENT: the decoder emitted none\n")).toBe(true);
    expect(isEnvironmentFailure("FAIL: 3 seeks returned the wrong frame\n")).toBe(false);
  });

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

describe("every gate has a per-process bound, and the model knows all of them", () => {
  // The structural fix gate-bounds.mjs asked for: give every gate a bound the
  // way gate-retry gives the determinism gate ATTEMPT_MS, and the job's worst
  // case stops being a MODEL of each gate's internals and becomes a SUM of
  // declared bounds. A model has to be re-derived whenever a gate changes and
  // silently rots when nobody does; a process bound is enforced by the runner.

  test("every gate npm runs is routed through the bounded runner", () => {
    // The drift this prevents: a new gate added to package.json that nobody
    // bounds, discovered when it holds a CI job to its cap.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const gateScripts = Object.entries(pkg.scripts as Record<string, string>)
      .filter(([name]) => /^gate(:|$)/.test(name) && name !== "gate:once");
    expect(gateScripts.length, "expected the four CI gates").toBeGreaterThanOrEqual(4);
    for (const [name, cmd] of gateScripts) {
      expect(cmd, `npm run ${name} must go through gate-run.mjs so it is bounded`)
        .toMatch(/gate-run\.mjs|gate-retry\.mjs/);
    }
  });

  // package.json is not the only caller. CI invoked identity-gate.mjs directly
  // — bypassing the bound entirely — and the package.json check above could not
  // see it. A gate is only bounded if EVERY caller goes through the runner.
  test("ci.yml runs gates through npm, never a gate script directly", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const direct = ci.split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /node\s+scripts\/[a-z-]*gate[a-z-]*\.mjs/.test(line));
    expect(direct.map((d) => `ci.yml:${d.n} ${d.line}`),
      "these bypass the per-gate process bound; use `npm run gate:<name>` instead")
      .toEqual([]);
  });

  // The runner wraps the gate, so anything CI passes after the script name has
  // to reach it. Dropping it left export-gate with no session directory and a
  // "no session found" exit 2 — a wrapper silently eating its child's args.
  test("the runner forwards arguments to the gate", () => {
    const src = readFileSync(join(root, "scripts", "gate-retry.mjs"), "utf8");
    expect(src, "gate-retry's CLI must pass argv past the target through to the gate")
      .toMatch(/process\.argv\.slice\(3\)/);
    expect(src, "and actually hand them to runWithRetry")
      .toMatch(/\[target, \.\.\.gateArgs\]/);
  });

  test("every routed gate has a declared process bound", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const targets = Object.entries(pkg.scripts as Record<string, string>)
      .filter(([name]) => /^gate(:|$)/.test(name) && name !== "gate:once")
      .map(([, cmd]) => cmd.match(/scripts\/([a-z-]+\.mjs)(?!.*scripts\/)/)?.[1])
      .filter((x): x is string => !!x && x !== "gate-run.mjs" && x !== "gate-retry.mjs");
    for (const t of targets) {
      expect(GATE_PROCESS_MS, `no process bound declared for scripts/${t}`).toHaveProperty(t);
    }
  });

  test("the worst case is the SUM of declared bounds, not a model of internals", () => {
    // Composition, not magnitude — the mistake #42 made and caught by mutation.
    // Deleting any gate's term must move the total.
    let expected = PRE_GATE_BUDGET_MS + SLOW_TESTS_MS;
    for (const [name, ms] of Object.entries(GATE_PROCESS_MS)) {
      expected += ms * (GATE_ATTEMPTS[name] ?? 1);
    }
    expect(worstCaseJobMs()).toBe(expected);
  });

  // MAGNITUDE IS NOT COMPOSITION. Verified: deleting GC_RETRIES * READY_MS from
  // export-gate's floor left all 20 tests green, because a 780 s bound clears
  // the reduced floor comfortably. The bound's own slack hides the deletion —
  // the exact failure #42 shipped and caught only by mutation. So the parts are
  // named here, and dropping any of them fails.
  test("each gate's floor ACCOUNTS FOR the waits that gate performs", () => {
    const lt = LAUNCH_MS + 2 * TEARDOWN_MS;
    const composed: Record<string, number> = {
      "gate.mjs": lt + READY_MS + EVAL_MS,
      "export-gate.mjs": lt + GC_RETRIES * READY_MS + 2 * EVAL_MS,
      "identity-gate.mjs": lt + GC_RETRIES * READY_MS + EVAL_MS,
      "seek-gate.mjs": lt + GC_RETRIES * READY_MS + SEEK_MS,
    };
    for (const [name, min] of Object.entries(composed)) {
      expect(gateFloorMs(name),
        `scripts/${name}'s floor must account for its launch, teardowns, ` +
        `readiness waits and evaluate bounds`).toBeGreaterThanOrEqual(min);
    }
  });

  // GC_RETRIES is arithmetic about someone else's loop, so it rots the moment
  // that loop changes. Read it off the gates instead of trusting the constant —
  // the same anti-drift check #42 put on READY_MS.
  test("GC_RETRIES matches the retry loop the gates actually run", () => {
    for (const f of ["seek-gate.mjs", "export-gate.mjs", "identity-gate.mjs"]) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      const m = src.match(/for \(let \w+ = 1; \w+ <= (\d+); \w+\+\+\)/);
      expect(m, `scripts/${f} must have the GC retry loop GC_RETRIES models`).not.toBeNull();
      expect(GC_RETRIES,
        `scripts/${f} retries ${m?.[1]} times; GC_RETRIES says ${GC_RETRIES}`)
        .toBeGreaterThanOrEqual(Number(m![1]));
    }
  });

  test("each gate's bound clears what that gate legitimately costs", () => {
    // Same rule ATTEMPT_MS follows: a bound below the floor fires before the
    // gate can say anything useful, and the informative inner message loses.
    for (const [name, ms] of Object.entries(GATE_PROCESS_MS)) {
      expect(ms, `scripts/${name}'s process bound is below its own floor`)
        .toBeGreaterThanOrEqual(gateFloorMs(name) * FLOOR_MARGIN);
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

  // STC-259 Mode B: the renderer's main thread blocks, so every in-page bound —
  // all of them JS timers — is dead in exactly the case it was written for, and
  // these runs historically printed nothing at all. The page's checkpoints are
  // collected out of process instead. A gate without this is a gate that can
  // still stall silently.
  test("every gate collects the page's checkpoints out of process", () => {
    for (const f of GATES) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      expect(src, `scripts/${f} must call instrumentPage — a wedged renderer ` +
        `cannot report from inside the page`).toMatch(/instrumentPage\(/);
      expect(src, `scripts/${f} must dump the trail when it labels ENVIRONMENT`)
        .toMatch(/trail\.dump\(\)/);
    }
  });

  // seek-gate hand-rolled `Promise.race([evaluate, setTimeout(...)])`, which
  // threw an UNTAGGED Error: isBoundFailure said no, and a Mode B wedge there
  // was reported as FAIL: — reddening CI for a machine fault, in the one gate
  // whose whole subject is that distinction. It also hardcoded 90_000 while
  // gate-bounds declared SEEK_MS = 90_000 and fed that to the worst-case model.
  test("no gate races a bare setTimeout against its evaluate", () => {
    const offenders = GATES.filter((f) => {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      return /Promise\.race\(\s*\[[\s\S]{0,400}?setTimeout/.test(src);
    });
    expect(offenders,
      `a hand-rolled race throws an Error with no boundFired tag, so the gate ` +
      `reports a machine fault as a code regression:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("seek-gate uses the declared SEEK_MS, not a copy of it", () => {
    const src = readFileSync(join(root, "scripts", "seek-gate.mjs"), "utf8");
    expect(src, "seek-gate must import SEEK_MS from gate-bounds").toMatch(/SEEK_MS/);
    // Comments stripped first. The first draft of this matched the raw source
    // and failed on the comment EXPLAINING that the literal used to be there —
    // a text guard tripping over prose, which is the same weakness that made a
    // CI fixture string read as a real skip earlier in this ticket.
    expect(withoutComments(src), "seek-gate must not hardcode its own bound")
      .not.toMatch(/90_000|90000/);
  });
});

describe("bounded()", () => {
  // The lazy label exists so a caller can fold in state that only exists once
  // the bound fires — how far a run got, which probe was last. seek-gate
  // hand-rolled its own setTimeout to get that and lost the boundFired tag.
  test("a thunk label is evaluated when the bound FIRES, not when it is set", async () => {
    let probes = 0;
    const p = new Promise(() => {});            // never settles
    const timer = setInterval(() => { probes++; }, 1);
    const err = await bounded(p, 30, () => `after ${probes} probes`)
      .then(() => null, (e: Error) => e);
    clearInterval(timer);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/after [1-9]\d* probes did not return within 30 ms/);
    expect((err as unknown as { boundFired?: boolean }).boundFired).toBe(true);
  });

  test("a plain string label still works", async () => {
    const err = await bounded(new Promise(() => {}), 20, "the thing")
      .then(() => null, (e: Error) => e);
    expect(err!.message).toBe("the thing did not return within 20 ms");
  });
});

describe("gate bounds — clearance against the CI job timeout", () => {
  test("the gates' bounds sum to less than the job cap, with margin", () => {
    // Kept honest against the workflow rather than against this comment. An
    // inner bound at or above the outer one loses the race, and the job
    // timeout — which reports as "cancelled" — wins with no explanation.
    // writer-gate already made exactly that mistake once.
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    // FOUR spaces: the JOB's cap. Steps declare their own timeout-minutes at
    // eight, and `\s*` would read whichever came first in the file — a clearance
    // computed against a step's bound would be silently meaningless.
    const m = ci.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m);
    expect(m, "ci.yml must declare a job-level timeout-minutes for this clearance to mean anything")
      .not.toBeNull();

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

  // test:slow is bounded as one process, like each gate, and that number is
  // counted in the worst case. If ci.yml and gate-bounds disagree, the model is
  // describing a job that is not the one running — which is how the worst case
  // came to say 21.5 min while one gate could take 30.
  test("the slow-test step's bound is the one the model counts", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const m = ci.match(/^ {8}timeout-minutes:\s*(\d+)\s*$/m);
    expect(m, "the test:slow step must declare its own timeout-minutes").not.toBeNull();
    expect(Number(m![1]) * 60_000,
      "ci.yml's test:slow step and SLOW_TESTS_MS disagree").toBe(SLOW_TESTS_MS);
  });

  // The inner bound must be able to fire before the outer one, or its message
  // is unreachable — the rule this repo applies to every other pair of bounds,
  // and one that was NOT being checked here: the slow config allowed 30 min per
  // test, which three tests could turn into 90, against a 12 min step and a
  // 65 min job. A hung slow test would have died anonymously at the step's cap
  // instead of vitest naming which test hung.
  test("a slow test's own timeout stays under the step's bound", () => {
    const cfg = readFileSync(join(root, "vitest.slow.config.ts"), "utf8");
    const m = withoutComments(cfg).match(/testTimeout:\s*([\d_]+)/);
    expect(m, "vitest.slow.config.ts must declare a testTimeout").not.toBeNull();
    const perTest = Number((m![1] ?? "").replace(/_/g, ""));
    expect(perTest, `a slow test may run ${perTest}ms inside a ${SLOW_TESTS_MS}ms step`)
      .toBeLessThan(SLOW_TESTS_MS);
  });

  // ring-overflow escalates its stall until the kernel's pipe overflows, so its
  // duration is a property of the machine. Its own comment recorded that it
  // "timed out on CI at 180 s" — then #54 put the whole slow suite into CI and
  // took it along. Three green runs, then a random red. CI names the file it
  // runs instead.
  test("CI's slow step does not run the pipe-dependent test", () => {
    const ci = withoutComments(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));
    const step = ci.match(/npm run test:slow[^\n]*/)?.[0] ?? "";
    expect(step, "the test:slow step must name the files it runs").toMatch(/\.slow\.test\.ts/);
    expect(step, "ring-overflow is machine-dependent and must not gate a push")
      .not.toMatch(/ring-overflow/);
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
    // Not a bare `>`. The clearance test below demands a real 5-minute margin
    // and says "not a token margin"; this one is the MORE dangerous of the two
    // — blowing the job cap is a loud timeout, crossing the floor is silent —
    // so it gets a real margin too. #42 shipped ATTEMPT_MS at 300s against a
    // floor that omitted the 60s readiness wait: 300 > 270 passed, while the
    // true floor was 330.
    expect(ATTEMPT_MS).toBeGreaterThanOrEqual(attemptFloorMs() * FLOOR_MARGIN);
  });

  test("READY_MS matches the wait the gate actually performs", () => {
    // Tied to the source, not to a number someone remembered. If a gate raises
    // its readiness timeout, the model must move with it.
    const src = readFileSync(join(root, "scripts", "gate.mjs"), "utf8");
    // [\s\S]*? not [^)]*: the predicate is an arrow function and contains ")".
    const m = src.match(/waitForFunction\([\s\S]*?timeout:\s*([0-9_]+)/);
    expect(m, "gate.mjs must declare a readiness timeout for READY_MS to track").not.toBeNull();
    expect(READY_MS).toBeGreaterThanOrEqual(Number(m![1]!.replace(/_/g, "")));
  });

  test("the floor ACCOUNTS FOR every bound one attempt passes through", () => {
    // Composition, not magnitude. The first draft of this asserted
    // `floor >= EVAL_MS + READY_MS`, which stayed green when READY_MS was
    // dropped from the floor entirely — the omission it existed to catch. A
    // guard satisfied by slack elsewhere is not a guard.
    expect(attemptFloorMs())
      .toBeGreaterThanOrEqual(EVAL_MS + 2 * TEARDOWN_MS + LAUNCH_MS + READY_MS);
  });

  test("the worst case ACCOUNTS FOR the readiness wait in every gate", () => {
    const nonRetriedGates = 3;                       // export, identity, seek
    const perGateOverhead = LAUNCH_MS + 2 * TEARDOWN_MS + READY_MS;
    expect(worstCaseJobMs()).toBeGreaterThanOrEqual(
      PRE_GATE_BUDGET_MS + SLOW_TESTS_MS + ATTEMPTS * ATTEMPT_MS
      + 2 * EVAL_MS + EVAL_MS + SEEK_MS
      + nonRetriedGates * perGateOverhead);
  });

  test("the retry is part of the worst case, not sitting outside it", () => {
    // Guards the specific regression: a model that ignores GATE_ATTEMPTS would
    // not move when the retry count does.
    //
    // Asserted by VARYING the count, not by multiplying the current one. The
    // previous form was `worstCaseJobMs() >= ATTEMPTS * ATTEMPT_MS`, which was
    // a real guard at ATTEMPTS = 3 and became vacuous the moment it dropped to
    // 1 on 2026-08-30: a model that deleted the term entirely computes
    // `ms * 1` and satisfies it. Third time this repo has shipped a guard that
    // its own slack could absorb.
    const at = (n: number) =>
      worstCaseJobMs({ attempts: { ...GATE_ATTEMPTS, "gate.mjs": n } });
    expect(at(3) - at(1), "the model must move when the retry count moves")
      .toBe(2 * ATTEMPT_MS);
    // ...and the model must read the production constant, not a copy of it.
    expect(worstCaseJobMs()).toBe(at(ATTEMPTS));
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

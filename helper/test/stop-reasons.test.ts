/**
 * STC-311 — every `stop.reason` the helper can write must validate against
 * anchors-2.
 *
 * The enum listed five reasons and their `-timeout` variants. The helper's
 * shutdown path (STC-304) writes `quit`, `stdin-closed` and `signal-N`, and
 * STC-305 added `stopped-during-start`: four families of value a real take
 * can carry that the schema refused. Nothing caught it because nothing
 * compared the two. `shutdown-during-recording.grant.test.ts` asserted
 * `quit` and `signal-15` without validating the document, and
 * `anchors/main.swift` validated documents but only ever built them with
 * `stopReason: "user"` — each half of the check existed, on different
 * reasons, so the gap sat exactly between them.
 *
 * This is the missing comparison, and it is deliberately NOT a second copy of
 * the reason list in TypeScript: a hand-kept list here would be a third place
 * to drift (this repo has fixed "one value, two copies" four times). The
 * SOURCE is the Swift call sites, read from the Swift; the schema is held to
 * them. A new `stop(reason: "…")` anywhere in the helper is covered the
 * moment it is written.
 *
 * Same shape as cursor-shape-names.test.ts, which holds the Swift shape list
 * to the events-2 enum.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");

/** The files that can name a stop reason. */
const SOURCES = ["helper/src/main.swift", "helper/src/Protocol.swift", "helper/src/Capture.swift"];

/**
 * Signals the helper installs a graceful handler for (main.swift's
 * `installSignalHandlers`), which is what `signal-\(sig)` interpolates.
 * Read from the Swift rather than assumed, so a signal added there is
 * covered here without an edit.
 */
function handledSignals(src: string): number[] {
  // main.swift has TWO `for sig in [...]` loops and only one of them writes a
  // reason: installCrashHandlers covers SIGSEGV/BUS/ILL/FPE/ABRT/TRAP and dies
  // with a stderr line, never reaching `stop`. Select the loop by what its
  // body does — the one that calls `shutdown(reason:)` — rather than by
  // position, which would silently pick the crash list.
  const loops = [...src.matchAll(/for sig in \[([^\]]+)\]/g)];
  const graceful = loops.filter((m) => {
    const body = src.slice(m.index!, m.index! + 1200);
    return /shutdown\(reason:/.test(body);
  });
  if (graceful.length !== 1) {
    throw new Error(
      `expected exactly one signal loop that calls shutdown(reason:), found ${graceful.length}. ` +
      "The signal reasons are no longer where this test looks for them.",
    );
  }
  const known: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3, SIGUSR1: 30, SIGUSR2: 31 };
  return [...graceful[0]![1]!.matchAll(/SIG[A-Z0-9]+|\d+/g)].map((x) => {
    const n = x[0]!;
    const v = known[n] ?? Number(n);
    if (!Number.isFinite(v)) throw new Error(`unknown signal name in main.swift: ${n}`);
    return v;
  });
}

/**
 * Every reason literal the helper can pass to `stop`/`shutdown`, including
 * `App.stop`'s own default.
 *
 * An interpolated reason is expanded where this test knows how; one it does
 * NOT know how to expand throws rather than being skipped, because a reason
 * built at runtime that nobody checked is precisely the hole this file
 * exists to close.
 */
function reasonsInSwift(): string[] {
  const out = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(join(root, file), "utf8");
    const lits = [
      ...src.matchAll(/(?:stop|shutdown)\(reason:\s*"([^"]*)"/g),
      ...src.matchAll(/reason:\s*String\s*=\s*"([^"]*)"/g),
    ].map((m) => m[1]!);
    for (const lit of lits) {
      if (!lit.includes("\\(")) { out.add(lit); continue; }
      if (/^signal-\\\(sig\)$/.test(lit)) {
        for (const s of handledSignals(src)) out.add(`signal-${s}`);
        continue;
      }
      throw new Error(
        `${file} builds a stop reason by interpolation this test cannot expand: "${lit}". ` +
        "Teach it how, or the reason goes unchecked against the schema.",
      );
    }
  }
  return [...out].sort();
}

const validateReason = (() => {
  const schema = JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema.properties.stop.properties.reason);
})();

describe("stop.reason — the helper and anchors-2 agree (STC-311)", () => {
  test("every reason the Swift can write is accepted by the schema", () => {
    const reasons = reasonsInSwift();
    // A guard on the guard: if the regexes stopped matching, this test would
    // pass by checking nothing — the "success by finding nothing to do" trap.
    // These four are the ones the ticket is about; the count catches a
    // narrowing of the search without pinning it to an exact number.
    expect(reasons).toEqual(expect.arrayContaining([
      "user", "quit", "stdin-closed", "stopped-during-start", "signal-15",
    ]));
    expect(reasons.length).toBeGreaterThanOrEqual(7);

    for (const r of reasons) {
      expect(validateReason(r), `the helper can write stop.reason "${r}", which anchors-2 refuses`).toBe(true);
    }
  });

  test("and by the schema with the -timeout suffix, which any reason can gain", () => {
    // CaptureSession.stop's backstop answers `\(reason)-timeout` whatever it
    // was given, so the suffix is not a fixed list of five: a shutdown whose
    // writer wedges writes `quit-timeout` or `signal-15-timeout`.
    for (const r of reasonsInSwift()) {
      expect(validateReason(`${r}-timeout`), `"${r}-timeout" is reachable but anchors-2 refuses it`).toBe(true);
    }
  });

  test("the rule still discriminates — it did not become 'any string'", () => {
    // Widening a schema until nothing fails is not a fix. A reason the helper
    // cannot produce must still be refused, or this file proves nothing.
    for (const bad of ["banana", "", "signal", "signal-", "signal-abc", "signal-15-timeou",
                       "user-timeout-timeout", "USER", " user"]) {
      expect(validateReason(bad), `anchors-2 accepts "${bad}", which the helper never writes`).toBe(false);
    }
  });
});

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import { applyDecoderPreference } from "../../harness/decoder.js";
import { decoderPreference } from "../src/decoder-preference.js";

const root = join(__dirname, "..", "..");

/**
 * A wedged gate run must say which decoder it was asking for.
 *
 * scripts/gate.mjs already refuses a run whose page used a preference the
 * runner did not send — but that check sits AFTER `bounded(page.evaluate(...))`
 * returns, and a Mode B wedge never returns. So the check cannot speak for the
 * only runs anyone consults it about, and #56's `prefer-software` experiment
 * was left resting on the assumption that addInitScript had applied.
 *
 * The mark closes that: it is emitted at module evaluation, before the first
 * decoder touch, over the one channel that survives a blocked main thread.
 */
describe("a wedged run's trail names the decoder preference (STC-259)", () => {
  const glob = globalThis as { __decoderPreference?: unknown };
  let logged: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = [];
    spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
  });
  afterEach(() => {
    delete glob.__decoderPreference;
    applyDecoderPreference(); // leave the module-level preference unset
    spy.mockRestore();        // ...after the spy has swallowed its mark
  });

  test("the preference the runner sent reaches both the config and the trail", () => {
    glob.__decoderPreference = "prefer-software";
    applyDecoderPreference();

    // The half gate.mjs already checks, and the half it cannot check on a wedge.
    expect(decoderPreference()).toEqual({ hardwareAcceleration: "prefer-software" });
    expect(logged.filter((l) => l.startsWith("[gate-mark"))).toEqual(
      [expect.stringContaining("decoder preference: prefer-software")]);
  });

  test("an ABSENT preference is marked too, not passed over in silence", () => {
    // The state #56 moved away from. A trail that only spoke up when a
    // preference was set could not tell "asked for software" from "the
    // addInitScript never ran", which is the exact ambiguity being closed.
    delete glob.__decoderPreference;
    applyDecoderPreference();

    expect(decoderPreference()).toEqual({});
    expect(logged.filter((l) => l.startsWith("[gate-mark"))).toEqual(
      [expect.stringContaining("decoder preference: unset")]);
  });

  test("the mark precedes the first decoder touch in every gate harness", () => {
    // Ordering is the whole point: a mark emitted after configure() blocks is
    // never sent. Module-evaluation order is the guarantee, so the call must
    // sit above the code that decodes — asserted by position, not by presence.
    for (const f of entries()) {
      const applyAt = f.src.indexOf("applyDecoderPreference()");
      // A call, not the import of the same name: harness/export.ts imports
      // loadSession on line 2, which put "starts decoding" above every
      // possible call site and made this guard unsatisfiable.
      const decodeAt = f.src.search(/\b(?:decodeAll|loadSession|runExport)\(|new \w*FrameSource\(/);
      expect(applyAt, `${f.path} must call applyDecoderPreference()`).toBeGreaterThan(-1);
      expect(applyAt,
        `${f.path} applies the preference AFTER it starts decoding; a mark that ` +
        `follows a synchronous configure() never leaves the process`)
        .toBeLessThan(decodeAt);
    }
  });
});

const entries = () =>
  readdirSync(join(root, "harness"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name !== "decoder.ts")
    .map((e) => ({
      path: join("harness", e.name),
      // Comments stripped: three guards in this repo have been satisfied or
      // tripped by prose rather than code. See _source-text.ts.
      src: withoutComments(readFileSync(join(root, "harness", e.name), "utf8")),
    }))
    .filter((f) => /decodeAll|FrameSource|loadSession|runExport/.test(f.src));

describe("one place reads the preference the runner hands the page", () => {
  test("no harness file rolls its own", () => {
    // Four entries carried an identical copy of this block. The copies were
    // benign only because they agreed; the mark is the kind of thing that gets
    // added to one of four and not the other three.
    const offenders = readdirSync(join(root, "harness"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name !== "decoder.ts")
      .map((e) => ({
        path: join("harness", e.name),
        src: withoutComments(readFileSync(join(root, "harness", e.name), "utf8")),
      }))
      .filter((f) => /__decoderPreference|setDecoderPreference\s*\(/.test(f.src))
      .map((f) => f.path);
    expect(offenders,
      "these read the preference directly instead of calling " +
      `applyDecoderPreference() from harness/decoder.ts:\n${offenders.join("\n")}`).toEqual([]);
  });
});

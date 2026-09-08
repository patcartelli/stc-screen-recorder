import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { parseShot, shotForWrite, versionFor } from "../src/shot.js";
import { layoutStill } from "../src/still-decorate.js";

/**
 * STC-301 gate 5 — the first committed schema version still loads and still
 * lays out to the same numbers.
 *
 * > "Includes a fixture from the first committed schema version, so a later
 * > change that breaks old shots fails here."
 *
 * `fixtures/shot-v1/` is FROZEN. Nothing may edit it to make a test pass: it
 * stands for the shots already sitting in people's folders, which no future
 * change gets to reach into and update. It exercises every part of shot-1 that
 * a document can carry — a window capture with alpha, a cursor, two redactions,
 * an explicit padding, shadow and background, and a canvas preset — because a
 * compatibility fixture that uses half the format only protects half of it.
 *
 * ## Why a layout and not an image
 *
 * The ticket says "renders byte-identically". Pixels are the still gate's job
 * (`npm run gate:still`, in a real browser), and a committed PNG would be a
 * stored constant across rasterisers this project does not control — the
 * reason STC-291 refused goldens and CLAUDE.md records the backend-dependent
 * hashes that prove it.
 *
 * What IS deterministic, and what actually breaks when someone changes the
 * layout maths, is the arithmetic: canvas size, where the content sits, the
 * resolved shadow, where each redaction and the cursor land. Those are
 * committed as `layout.json` and compared exactly. It is a golden of NUMBERS,
 * which is the version of this idea that survives a Chromium bump.
 *
 * **Every number in `layout.json` was derived by hand before it was committed**
 * — pxPerPoint 2 from a 1600 px frame over 800 pt of window; the shadow's reach
 * (96 × 1.5 + 36 = 180) correctly beating the requested 9% padding (108), which
 * is STC-291's clipped-shadow trap being exercised rather than merely recorded;
 * the 16:9 preset growing the width to 2773; and the cursor at
 * 587 + (640 − 200) × 2 = 1467. A golden nobody checked is just a note of what
 * the code did on the day.
 *
 * ## When this test fails
 *
 * It means a change altered how an EXISTING document renders. That is
 * sometimes correct — a bug fix in the layout maths is exactly that — and the
 * procedure is: work out which number moved and why, satisfy yourself the new
 * one is right BY HAND as above, then update `layout.json` in the same commit
 * with the reason in the message. What is not allowed is regenerating it
 * because the test went red.
 */

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

const frozen = load("fixtures/shot-v1/shot.json");
const frozenLayout = load("fixtures/shot-v1/layout.json");
const validateV1 = new Ajv({ allErrors: true, strict: true })
  .compile(load("schema/shot-1.schema.json"));

describe("gate 5: a shot-1 document from the first committed version", () => {
  test("still validates against shot-1", () => {
    expect(frozen.version).toBe(1);
    expect(validateV1(frozen), JSON.stringify(validateV1.errors, null, 2)).toBe(true);
  });

  test("still loads, with every block intact", () => {
    const shot = parseShot(frozen);
    expect(shot.version).toBe(1);
    expect(shot.kind).toBe("window");
    expect(shot.window).toEqual({
      id: 4711, app: "Finder", title: "Downloads",
      bounds: { x: 200, y: 120, width: 800, height: 600 },
    });
    expect(shot.cursor).toEqual({ x: 640, y: 400, shape: "pointingHand" });
    expect(shot.decoration.redactions).toHaveLength(2);
    expect(shot.decoration.mode).toBe("window-shadow-background");
    expect(shot.decoration.canvas).toBe("16:9");
    // The field shot-2 added, absent on disk and empty in memory — which is
    // what makes an old document readable by a new build at all.
    expect(shot.decoration.annotations).toEqual([]);
  });

  test("still lays out to exactly the committed numbers", () => {
    expect(layoutStill(parseShot(frozen))).toEqual(frozenLayout);
  });

  /**
   * And a new build does not quietly upgrade it. Loading an old shot and
   * writing it back must leave a v1 document — otherwise merely opening the
   * library would rewrite everybody's shots into a version their previous
   * build cannot read.
   */
  test("is not silently upgraded by being read and written", () => {
    const shot = parseShot(frozen);
    expect(versionFor(shot)).toBe(1);
    const written = JSON.parse(JSON.stringify(shotForWrite(shot)));
    expect(written.version).toBe(1);
    expect("annotations" in written.decoration).toBe(false);
    expect(validateV1(written), JSON.stringify(validateV1.errors, null, 2)).toBe(true);
    // Semantically the document it started as — a round trip loses nothing.
    //
    // Not byte-for-byte: `parseShot` returns a normalised copy and writes its
    // own key order, so the bytes legitimately differ while every value is the
    // same. The ticket's "renders byte-identically" is about the RENDER, and
    // that is the layout assertion above; demanding it of the JSON too was an
    // over-reach that would have pinned key order as if it were a guarantee.
    // Checked before relaxing: the only difference really was ordering.
    expect(parseShot(written)).toEqual(parseShot(frozen));
  });

  /**
   * The fixture is only worth anything if it is REALLY frozen. This is the
   * tripwire for the tempting fix — editing the fixture until the test passes —
   * which would quietly delete the guarantee while leaving a green tick.
   */
  test("the fixture is the shape this gate was written against", () => {
    // Not a hash: a hash tells you it changed and nothing else. These are the
    // properties that make it a USEFUL compatibility fixture, so a fixture
    // edited down to something simpler fails here and says which part went.
    expect(frozen.decoration.redactions.length, "redactions were removed").toBe(2);
    expect(frozen.decoration.background, "the background block went").toBeDefined();
    expect(frozen.decoration.shadow, "the shadow block went").toBeDefined();
    expect(frozen.decoration.paddingPct, "the explicit padding went").toBeGreaterThan(0);
    expect(frozen.cursor, "the cursor block went").toBeDefined();
    expect(frozen.window?.title, "the window's optional fields went").toBe("Downloads");
    expect(frozen.display.colorSpace, "the colour space went").toBeDefined();
    expect(frozen.frame.alpha, "the alpha flag went").toBe(true);
    expect("annotations" in frozen.decoration,
           "a v2 field was added to the v1 fixture — it is meant to stay v1").toBe(false);
  });
});

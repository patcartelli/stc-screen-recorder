import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary, listTakes, THUMBNAIL_FILE } from "../src/library.js";
import { setTakeLabel } from "../src/takes.js";

/**
 * One index over two formats (STC-294).
 *
 * The ticket's constraint is the thing under test here: *"one storage root, one
 * index. Two formats is a decision; two libraries is not."* So these check that
 * a directory of each kind is classified from ONE pass, that they interleave by
 * time rather than clumping by kind, and — the case that was actually broken
 * before this — that a still is no longer reported as a broken recording.
 *
 * That a view never branches on kind is a different claim and is checked
 * structurally in `library-seam.test.ts`; that the phase-2 recording behaviour
 * survived the scanner moving is `take-list.test.ts`, unchanged but for its
 * import.
 */

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stc-lib2-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const env = () => ({ STC_RECORDINGS_DIR: root } as NodeJS.ProcessEnv);

function makeRecording(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "anchors.json"), JSON.stringify({
    version: 2,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3840, height: 2160, codec: "h264", firstFrameNs: 200_000_000 },
    files: { display: "display.mp4" },
    stop: { t: 20_000_000_000, reason: "user" },
  }));
  writeFileSync(join(dir, "events.json"), JSON.stringify({ version: 1, events: [
    { t: 1, kind: "move", x: 1, y: 1 }, { t: 2, kind: "move", x: 2, y: 2 },
  ] }));
  writeFileSync(join(dir, "display.mp4"), Buffer.alloc(4096));
  return dir;
}

interface StillOver { shot?: any; frame?: boolean; thumb?: boolean }

function makeStill(name: string, over: StillOver = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const shot = over.shot !== undefined ? over.shot : {
    version: 1,
    kind: "display-crop",
    capturedAtNs: "1000000000",
    timebase: { numer: 125, denom: 3 },
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    crop: { x: 100, y: 80, width: 640, height: 360 },
    frame: { file: "frame.png", width: 1280, height: 720, alpha: false },
    decoration: { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] },
  };
  writeFileSync(join(dir, "shot.json"),
    typeof shot === "string" ? shot : JSON.stringify(shot));
  if (over.frame !== false) writeFileSync(join(dir, "frame.png"), Buffer.alloc(2048));
  if (over.thumb) writeFileSync(join(dir, THUMBNAIL_FILE), Buffer.alloc(512));
  return dir;
}

describe("listLibrary — one index, both kinds", () => {
  test("an empty root is not an error", async () => {
    const { items, invalid } = await listLibrary(env());
    expect(items).toEqual([]);
    expect(invalid).toEqual([]);
  });

  test("a missing root is not an error either", async () => {
    const { items, invalid } = await listLibrary({ STC_RECORDINGS_DIR: join(root, "nope") });
    expect(items).toEqual([]);
    expect(invalid).toEqual([]);
  });

  test("a stills-only library lists stills and reports nothing broken", async () => {
    makeStill("2026-09-08_10-00-00");
    makeStill("2026-09-08_10-00-01");
    const { items, invalid } = await listLibrary(env());
    expect(invalid, JSON.stringify(invalid)).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["still", "still"]);
    expect(items.map((i) => i.badge)).toEqual(["Still", "Still"]);
  });

  test("a mixed library interleaves by time, not by kind", async () => {
    // Deliberately out of both insertion order and kind order: the sort key is
    // the directory name, which is a timestamp for BOTH kinds — that shared key
    // is the whole reason one index is possible.
    makeRecording("2026-09-08_10-00-02");
    makeStill("2026-09-08_10-00-03");
    makeRecording("2026-09-08_10-00-00");
    makeStill("2026-09-08_10-00-01");

    const { items, invalid } = await listLibrary(env());
    expect(invalid, JSON.stringify(invalid)).toEqual([]);
    expect(items.map((i) => `${i.id}:${i.kind}`)).toEqual([
      "2026-09-08_10-00-03:still",
      "2026-09-08_10-00-02:recording",
      "2026-09-08_10-00-01:still",
      "2026-09-08_10-00-00:recording",
    ]);
  });

  /**
   * The bug this ticket actually fixes.
   *
   * Stills have gone into the same root since STC-289, and the scanner looked
   * only for anchors.json — so every still capture was listed as a broken
   * recording, with the reason "no anchors.json — not a recording". True, and
   * useless.
   */
  test("a still is no longer reported as a broken recording", async () => {
    makeStill("2026-09-08_10-00-00");
    const { items, invalid } = await listLibrary(env());
    expect(invalid).toEqual([]);
    expect(items).toHaveLength(1);
    // And the recordings-only view simply does not see it — rather than seeing
    // it as damage.
    const takes = await listTakes(env());
    expect(takes.takes).toEqual([]);
    expect(takes.invalid).toEqual([]);
  });

  test("a directory that is neither kind is still reported, with a reason", async () => {
    mkdirSync(join(root, "2026-09-08_10-00-00"), { recursive: true });
    writeFileSync(join(root, "2026-09-08_10-00-00", "notes.txt"), "hello");
    const { items, invalid } = await listLibrary(env());
    expect(items).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.reason).toMatch(/anchors/i);
  });
});

describe("listLibrary — a still that cannot be rendered says so", () => {
  test("a shot.json parseShot refuses is invalid, with the loader's own message", async () => {
    // `parseShot` REFUSES rather than defaults, deliberately — the document IS
    // the still. A tile for a document that cannot be loaded would fail the
    // moment it was opened, so it is reported instead.
    makeStill("2026-09-08_10-00-00", { shot: { version: 1, kind: "display-crop" } });
    const { items, invalid } = await listLibrary(env());
    expect(items).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.reason).toMatch(/shot\.json is unreadable/);
  });

  test("an unknown field is refused rather than ignored", async () => {
    // shot-1 is closed in both directions (`noExtra` throws), which is what
    // makes adding a field a shot-2 decision — see docs/STC-300-FORMAT-AUDIT.md.
    const shot = JSON.parse(JSON.stringify({
      version: 1, kind: "display-crop", capturedAtNs: "1000000000",
      timebase: { numer: 125, denom: 3 },
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840,
                 pixelHeight: 2160, backingScale: 2, originX: 0, originY: 0 },
      crop: { x: 0, y: 0, width: 640, height: 360 },
      frame: { file: "frame.png", width: 1280, height: 720, alpha: false },
      decoration: { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] },
      somethingNew: true,
    }));
    makeStill("2026-09-08_10-00-00", { shot });
    const { invalid } = await listLibrary(env());
    expect(invalid[0]!.reason).toMatch(/field this version does not know/);
  });

  test("a missing frame is invalid, named by the file the document asked for", async () => {
    makeStill("2026-09-08_10-00-00", { frame: false });
    const { items, invalid } = await listLibrary(env());
    expect(items).toEqual([]);
    expect(invalid[0]!.reason).toMatch(/frame\.png is missing/);
  });
});

describe("the presentation each kind owns", () => {
  test("a still states its size, mode and redaction count", async () => {
    makeStill("2026-09-08_10-00-00", { shot: {
      version: 1, kind: "window", capturedAtNs: "1000000000",
      timebase: { numer: 125, denom: 3 },
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840,
                 pixelHeight: 2160, backingScale: 2, originX: 0, originY: 0 },
      window: { id: 7, app: "Safari", bounds: { x: 0, y: 0, width: 360, height: 240 } },
      frame: { file: "frame.png", width: 720, height: 480, alpha: true },
      decoration: {
        mode: "window-shadow", canvas: "natural", cursor: false,
        redactions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
      },
    } });
    const [item] = (await listLibrary(env())).items;
    expect(item!.summary).toContain("720×480");
    expect(item!.summary).toContain("Window + shadow");
    expect(item!.summary).toContain("1 redaction");
    // Singular, not "1 redactions" — the one thing about this line a person
    // would actually notice being wrong.
    expect(item!.summary).not.toContain("1 redactions");
  });

  test("no redactions are not mentioned at all", async () => {
    makeStill("2026-09-08_10-00-00");
    const [item] = (await listLibrary(env())).items;
    expect(item!.summary).not.toMatch(/redaction/);
  });

  test("a still offers open and duplicate; a recording offers preview and neither", async () => {
    makeStill("2026-09-08_10-00-01");
    makeRecording("2026-09-08_10-00-00");
    const [still, recording] = (await listLibrary(env())).items;

    // The actions are what a view renders and dispatches on. That a still can
    // be duplicated and a recording cannot is expressed HERE, as a list, which
    // is what keeps it out of the view as a branch.
    expect(still!.actions.map((a) => a.id)).toEqual(
      ["open", "rename", "duplicate", "reveal", "delete"]);
    expect(recording!.actions.map((a) => a.id)).toEqual(
      ["open", "rename", "reveal", "delete"]);
    // Same action id, different word, decided by the adapter.
    expect(still!.actions.find((a) => a.id === "open")!.label).toBe("Open");
    expect(recording!.actions.find((a) => a.id === "open")!.label).toBe("Preview");
  });

  test("every kind offers rename and delete — the shared UI has something to bind to", async () => {
    makeStill("2026-09-08_10-00-01");
    makeRecording("2026-09-08_10-00-00");
    for (const item of (await listLibrary(env())).items) {
      const ids = item.actions.map((a) => a.id);
      expect(ids, item.kind).toContain("rename");
      expect(ids, item.kind).toContain("delete");
    }
  });

  test("a cached thumbnail is named; an uncached one asks to be rendered", async () => {
    makeStill("2026-09-08_10-00-01", { thumb: true });
    makeStill("2026-09-08_10-00-00");
    const [cached, fresh] = (await listLibrary(env())).items;
    expect(cached!.thumbnail).toEqual({ source: "file", file: THUMBNAIL_FILE });
    expect(fresh!.thumbnail).toEqual({ source: "render" });
  });

  test("a recording has no thumbnail in this slice, and says so structurally", async () => {
    makeRecording("2026-09-08_10-00-00");
    const [item] = (await listLibrary(env())).items;
    // Not `{source:"render"}` with the renderer quietly failing: a poster frame
    // for every recording is a decode per tile, deferred deliberately.
    expect(item!.thumbnail).toEqual({ source: "none" });
  });

  test("a camera that recorded nothing is stated on the tile (STC-287)", async () => {
    const dir = makeRecording("2026-09-08_10-00-00");
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    anchors.camera = { present: false };
    writeFileSync(join(dir, "anchors.json"), JSON.stringify(anchors));
    const [item] = (await listLibrary(env())).items;
    expect(item!.notes.join(" ")).toMatch(/recorded no frames/);
  });
});

describe("labelling is one mechanism over both kinds", () => {
  test("a label set on a still comes back on its item", async () => {
    const dir = makeStill("2026-09-08_10-00-00");
    await setTakeLabel(env(), dir, "The pricing page");
    const [item] = (await listLibrary(env())).items;
    expect(item!.label).toBe("The pricing page");
    // The id stays the directory name: a label is a display name and never the
    // identity, or renaming would scramble the sort and break open paths.
    expect(item!.id).toBe("2026-09-08_10-00-00");
  });

  test("a corrupt take.json costs the label, never the still", async () => {
    const dir = makeStill("2026-09-08_10-00-00");
    writeFileSync(join(dir, "take.json"), "{not json");
    const { items, invalid } = await listLibrary(env());
    expect(invalid).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBeUndefined();
  });
});

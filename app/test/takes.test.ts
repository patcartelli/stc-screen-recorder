import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { takesRoot, newTakeDir, insideTakesRoot, duplicateTake } from "../src/takes.js";

describe("where recordings go", () => {
  test("defaults to ~/Desktop/stc — durable and visible, not scratch", () => {
    expect(takesRoot({})).toBe(join(homedir(), "Desktop", "stc"));
  });

  test("never defaults into a temp directory that the OS sweeps", () => {
    // /var/folders/.../T is purged on boot and swept after ~3 days. A take is a
    // deliverable, not scratch, and must not live somewhere it can vanish.
    expect(takesRoot({})).not.toMatch(/\/var\/folders|\/tmp|[/\\]T$/);
  });

  test("STC_RECORDINGS_DIR overrides it, so tests need not litter the Desktop", () => {
    expect(takesRoot({ STC_RECORDINGS_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });

  test("take directories are timestamped, sortable and collision-free", () => {
    const at = new Date("2026-08-24T15:11:32");
    expect(newTakeDir({}, at)).toBe(join(homedir(), "Desktop", "stc", "2026-08-24_15-11-32"));
    // a second take in the same second must not reuse the directory
    const a = newTakeDir({ STC_RECORDINGS_DIR: "/r" }, at);
    const b = newTakeDir({ STC_RECORDINGS_DIR: "/r" }, at, ["2026-08-24_15-11-32"]);
    expect(b).not.toBe(a);
    expect(b).toMatch(/2026-08-24_15-11-32-2$/);
  });
});

/**
 * STC-293 review: `dir.startsWith(takesRoot(env))` was used as "is this inside
 * the recordings folder?" in five handlers, and is not that test.
 *
 * It let two different strings through, both renderer-supplied. On the read
 * paths that leaks a file; on `still:export`, which creates directories and
 * writes an image, it plants one. Each case below is a string that PASSED the
 * old check.
 */
describe("insideTakesRoot (STC-293 review)", () => {
  const env = { STC_RECORDINGS_DIR: "/takes" } as NodeJS.ProcessEnv;

  test("a real take inside the root is accepted", () => {
    expect(insideTakesRoot(env, "/takes/2026-09-08_10-00-00")).toBe(true);
    expect(insideTakesRoot(env, "/takes/a/b")).toBe(true);
  });

  test("a `..` segment cannot walk out, however deep", () => {
    // `"/takes/../../tmp/evil".startsWith("/takes")` is true, and join()
    // resolves it to /tmp/evil.
    expect(insideTakesRoot(env, "/takes/../../tmp/evil")).toBe(false);
    expect(insideTakesRoot(env, "/takes/a/../../../etc")).toBe(false);
  });

  test("a sibling folder sharing the prefix is not inside it", () => {
    // The second hole, and the quieter one: no traversal, just a name.
    expect(insideTakesRoot(env, "/takes-other")).toBe(false);
    expect(insideTakesRoot(env, "/takes-other/shot")).toBe(false);
  });

  test("the root itself is refused — every caller wants a take, not the folder", () => {
    expect(insideTakesRoot(env, "/takes")).toBe(false);
    expect(insideTakesRoot(env, "/takes/")).toBe(false);
    // ...including when it is spelled indirectly.
    expect(insideTakesRoot(env, "/takes/a/..")).toBe(false);
  });

  test("a non-path is refused rather than throwing", () => {
    expect(insideTakesRoot(env, "")).toBe(false);
    expect(insideTakesRoot(env, undefined as never)).toBe(false);
    expect(insideTakesRoot(env, 42 as never)).toBe(false);
  });
});

/**
 * `duplicateTake` (STC-345) — the take library study's own defect.
 *
 * `still:duplicate` used to compute its destination from a filesystem
 * snapshot and `mkdir(..., {recursive:true})`, which does not throw when the
 * directory already exists — so two duplicates racing (a quick double-click,
 * or Duplicate pressed on two different tiles inside the same second) could
 * both compute the SAME destination and both copy into it, interleaving two
 * unrelated shots' files in one directory. Same shape as the filename race
 * this repo already fixed twice (`still-io.ts`, STC-296's stacking) — an
 * in-process claim, held for the duration and released in a `finally`.
 */
describe("duplicateTake (STC-345)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stc-dup-"));
    env = { STC_RECORDINGS_DIR: root };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function makeSource(name: string, contents: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(contents)) writeFileSync(join(dir, file), body);
    return dir;
  }

  test("copies every file but the cached thumbnail", async () => {
    const src = makeSource("2026-09-10_10-00-00",
      { "shot.json": "{}", "frame.png": "pixels", "thumb.png": "cached" });
    const dest = await duplicateTake(env, src, "thumb.png");
    expect(readdirSync(dest).sort()).toEqual(["frame.png", "shot.json"]);
  });

  /**
   * The regression. Two duplicates of the SAME source, fired together —
   * exactly a double-click on one tile's Duplicate button — must produce TWO
   * complete, independent copies, never one directory both wrote into.
   *
   * Proven by mutation: reverting `duplicateTake` to the pre-STC-345 shape
   * (read the listing, `mkdir` unconditionally, no claim) makes this fail —
   * either one destination for both calls, or a directory missing a file the
   * other call's `mkdir` raced past.
   */
  test("two concurrent duplicates of the same take never collide on one destination", async () => {
    const src = makeSource("2026-09-10_10-00-00", { "shot.json": "{}", "frame.png": "pixels" });
    const [a, b] = await Promise.all([
      duplicateTake(env, src, "thumb.png"),
      duplicateTake(env, src, "thumb.png"),
    ]);
    expect(a).not.toBe(b);
    for (const dest of [a, b]) {
      expect(readdirSync(dest).sort()).toEqual(["frame.png", "shot.json"]);
    }
  });

  /** The same race, from two DIFFERENT sources — the case that silently corrupts rather than merely duplicating. */
  test("two concurrent duplicates of DIFFERENT takes never interleave their files", async () => {
    const srcA = makeSource("2026-09-10_10-00-00", { "shot.json": "A", "frame.png": "A-pixels" });
    const srcB = makeSource("2026-09-10_10-00-01", { "shot.json": "B", "frame.png": "B-pixels" });
    const [destA, destB] = await Promise.all([
      duplicateTake(env, srcA, "thumb.png"),
      duplicateTake(env, srcB, "thumb.png"),
    ]);
    expect(destA).not.toBe(destB);
    const read = (dir: string, file: string) => readdirSync(dir).includes(file)
      ? readFileSync(join(dir, file), "utf8") : undefined;
    const contentsOf = (dir: string) => ({ shot: read(dir, "shot.json"), frame: read(dir, "frame.png") });
    const [ca, cb] = [contentsOf(destA), contentsOf(destB)];
    // Each destination is either wholly A or wholly B — never a mix of the two.
    const isA = (c: typeof ca) => c.shot === "A" && c.frame === "A-pixels";
    const isB = (c: typeof ca) => c.shot === "B" && c.frame === "B-pixels";
    expect(isA(ca) || isB(ca)).toBe(true);
    expect(isA(cb) || isB(cb)).toBe(true);
    expect([isA(ca), isA(cb)].filter(Boolean)).toHaveLength(1);
  });

  test("the claim releases: a third call afterward does not skip a name forever", async () => {
    const src = makeSource("2026-09-10_10-00-00", { "shot.json": "{}" });
    const [a, b] = await Promise.all([
      duplicateTake(env, src, "thumb.png"),
      duplicateTake(env, src, "thumb.png"),
    ]);
    const c = await duplicateTake(env, src, "thumb.png");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

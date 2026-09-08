import { describe, test, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { takesRoot, newTakeDir, insideTakesRoot } from "../src/takes.js";

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

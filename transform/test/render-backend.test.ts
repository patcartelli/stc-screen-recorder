import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import { SOFTWARE_RENDER_ARGS } from "../../scripts/render-backend.mjs";

const root = join(__dirname, "..", "..");

/**
 * The pre-encode hash depends on the rasterization backend — measured, and the
 * two hashes are in scripts/render-backend.mjs. A cross-engine comparison is
 * only meaningful when both sides are pinned to the same one, and two copies of
 * the flag list is precisely how the two sides drift back apart.
 *
 * This session has now fixed the same "one value, two copies" defect four
 * times: the project defaults, SEEK_MS, the slow-config glob, and this.
 */
describe("the rasterization backend is declared once", () => {
  const sourcesIn = (dir: string) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|mjs)$/.test(e.name) && e.name !== "render-backend.mjs")
      .map((e) => ({
        path: join(dir, e.name),
        src: withoutComments(readFileSync(join(root, dir, e.name), "utf8")),
      }));

  test("nothing hardcodes the flags it should be importing", () => {
    const offenders = [...sourcesIn("scripts"), ...sourcesIn(join("app", "test"))]
      .filter((f) => /--disable-gpu|--use-gl=/.test(f.src))
      .map((f) => f.path);
    expect(offenders,
      "these carry their own copy of the render flags; import them from " +
      `scripts/render-backend.mjs instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the flags actually pin software rendering", () => {
    // Not a spelling test: each of these is load-bearing, and dropping any one
    // lets Chromium fall back to a different rasterizer on some machine.
    expect(SOFTWARE_RENDER_ARGS).toContain("--disable-gpu");
    expect(SOFTWARE_RENDER_ARGS).toContain("--use-gl=swiftshader");
  });
});

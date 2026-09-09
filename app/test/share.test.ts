import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_EMBED_TEMPLATE, DEFAULT_SLUG, SLUG_PATTERN, embedSnippet, exportManifestName,
  exportMediaName, planPublish, publicSrc, slugIsValid,
} from "../src/share.js";
import { DEFAULT_SHARE_SETTINGS } from "../src/settings.js";

/**
 * STC-242 — the publish decisions, tested where they are decidable.
 *
 * `main.ts` copies a file and reveals it and decides nothing, so everything
 * worth asserting is in here and needs no Electron.
 */

const REQ = {
  takeName: "2026-09-09_14-22-05",
  takeDir: "/Users/x/Desktop/stc/2026-09-09_14-22-05",
  exportExists: true,
  destination: "/Users/x/site/public/lab/network",
  slug: "network",
};

describe("planPublish", () => {
  test("names the destination file from the SLUG, never from the take", () => {
    const plan = planPublish(REQ);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.name).toBe("network.mp4");
    expect(plan.to).toBe("/Users/x/site/public/lab/network/network.mp4");
    // The SOURCE still carries the take's timestamp — that is what makes the
    // export traceable to a recording. Only the published copy is stable.
    expect(plan.from).toContain("export-2026-09-09_14-22-05.mp4");
  });

  /**
   * The property the whole design rests on: two different takes publish to the
   * SAME path. That is what lets the page embed a fixed src and a re-shoot
   * cost nothing, and it is the reason the overwrite is deliberate rather than
   * a bug — so it is asserted rather than left as a comment.
   */
  test("two takes of the same demo publish to one path", () => {
    const a = planPublish(REQ);
    const b = planPublish({ ...REQ, takeName: "2026-10-01_09-00-00",
                            takeDir: "/Users/x/Desktop/stc/2026-10-01_09-00-00" });
    expect(a.kind).toBe("ready");
    expect(b.kind).toBe("ready");
    if (a.kind !== "ready" || b.kind !== "ready") throw new Error("unreachable");
    expect(b.to).toBe(a.to);
    expect(b.from).not.toBe(a.from);
  });

  test("refuses with a reason rather than defaulting, for each way it can fail", () => {
    const noDest = planPublish({ ...REQ, destination: null });
    expect(noDest.kind).toBe("no-destination");
    expect(noDest.kind !== "ready" && noDest.message).toMatch(/site repo/i);

    const noExport = planPublish({ ...REQ, exportExists: false });
    expect(noExport.kind).toBe("no-export");
    // It names the file it looked for, so "export it, then share" is
    // actionable rather than a shrug.
    if (noExport.kind !== "no-export") throw new Error("unreachable");
    expect(noExport.expected).toBe("export-2026-09-09_14-22-05.mp4");

    const badSlug = planPublish({ ...REQ, slug: "My Demo" });
    expect(badSlug.kind).toBe("bad-slug");
    expect(badSlug.kind !== "ready" && badSlug.message).toContain("My Demo");
  });

  /**
   * Ordering is a decision, not an accident: a run with two things wrong
   * reports the slug first, because it is the one the user typed and the one
   * they can fix without a file picker.
   */
  test("reports the slug before the destination when both are wrong", () => {
    expect(planPublish({ ...REQ, slug: "", destination: null }).kind).toBe("bad-slug");
  });

  test("joins a destination that already ends in a separator without doubling it", () => {
    const plan = planPublish({ ...REQ, destination: "/Users/x/site/public/lab/network/" });
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.to).toBe("/Users/x/site/public/lab/network/network.mp4");
    expect(plan.to).not.toContain("//");
  });
});

describe("slugs", () => {
  test("accepts what a URL and a filename can both carry", () => {
    for (const ok of ["network", "vividly", "a", "demo-2", "x1"]) {
      expect(slugIsValid(ok), ok).toBe(true);
    }
  });

  /**
   * Each of these is refused for its own reason, and traversal is the one that
   * matters most: the slug becomes a path segment in a `copyFile` destination,
   * so a slug that could escape would write outside the folder the user chose.
   */
  test("refuses traversal, separators, spaces, dots, case and emptiness", () => {
    for (const bad of ["..", "../etc", "a/b", "a b", "a.mp4", "Network", "", "-lead", "a_b"]) {
      expect(slugIsValid(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("the pattern is anchored, so a bad slug cannot hide inside a good one", () => {
    expect(SLUG_PATTERN.test("ok/../../etc")).toBe(false);
    expect(SLUG_PATTERN.source.startsWith("^")).toBe(true);
    expect(SLUG_PATTERN.source.endsWith("$")).toBe(true);
  });

  test("the default slug is itself valid", () => {
    expect(slugIsValid(DEFAULT_SLUG)).toBe(true);
    expect(slugIsValid(DEFAULT_SHARE_SETTINGS.slug)).toBe(true);
  });
});

describe("the embed snippet", () => {
  test("substitutes what it knows", () => {
    const out = embedSnippet(DEFAULT_EMBED_TEMPLATE,
      { src: "/lab/network/network.mp4", slug: "network", width: 1920, height: 1080 });
    expect(out).toContain('src="/lab/network/network.mp4"');
    expect(out).toContain('width="1920"');
    expect(out).toContain('height="1080"');
    expect(out).not.toContain("{");
  });

  /**
   * The half that matters more than the substitution.
   *
   * An export whose manifest is missing has no dimensions to offer, and the
   * snippet must SAY so rather than paste `width="0"` into somebody's page — a
   * zero renders as a real attribute and a collapsed video, which is a wrong
   * answer wearing a right answer's clothes.
   */
  test("leaves a token unsubstituted when the value is unknown", () => {
    const out = embedSnippet(DEFAULT_EMBED_TEMPLATE, { src: "/x.mp4", slug: "x" });
    expect(out).toContain("{width}");
    expect(out).toContain("{height}");
    expect(out).not.toContain('width="0"');
    expect(out).toContain('src="/x.mp4"');
  });

  test("leaves a token it does not know alone", () => {
    expect(embedSnippet('<video src="{src}" poster="{poster}">',
                        { src: "/x.mp4", slug: "x" })).toContain("{poster}");
  });

  test("the public src is built from the slug the file was published under", () => {
    expect(publicSrc("network")).toBe("/lab/network/network.mp4");
    expect(publicSrc("network", "/videos/")).toBe("/videos/network/network.mp4");
  });
});

/**
 * The drift guard, and the reason this file reaches for the filesystem.
 *
 * The export names were built inline in `renderer.ts` as template literals,
 * and STC-242's publish path — in the MAIN process — has to find that exact
 * file afterwards. That is one filename rule with two authors in two
 * processes, which CLAUDE.md records this repo fixing four times in a single
 * session under "one value, two copies".
 *
 * A test that only checked `exportMediaName` would pass just as well with the
 * literal back in the renderer, so this greps the real file. The controls
 * matter more than the assertion (STC-294's lesson): the pattern is proven to
 * fire against the literal it is meant to catch, so an empty result means the
 * second copy is gone rather than that the regex never worked.
 */
describe("the export filename lives in exactly one place", () => {
  const root = join(__dirname, "..", "..");
  const renderer = readFileSync(join(root, "app", "src", "renderer.ts"), "utf8");
  /** The shape of the old inline literal: `export-${…}.mp4` or `.json`. */
  const INLINE = /`export-\$\{[^`]*\}\.(mp4|json)`/g;

  test("the pattern can fire", () => {
    const planted = "const name = `export-${openTakeName}.mp4`;";
    expect(planted.match(INLINE)).toHaveLength(1);
    expect("`export-${n}.json`".match(INLINE)).toHaveLength(1);
  });

  test("and does not fire on the renderer as it stands", () => {
    // Comments are blanked first: this file's own explanation of the rule
    // mentions the literal, and a guard that flags a file for DISCUSSING the
    // rule it keeps is a guard someone turns off (STC-294).
    const code = renderer
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code.match(INLINE) ?? []).toEqual([]);
  });

  test("and the renderer uses the shared functions instead", () => {
    expect(renderer).toContain("exportMediaName(openTakeName)");
    expect(renderer).toContain("exportManifestName(openTakeName)");
  });

  test("the two names agree on the stem, so they land beside each other", () => {
    const take = "2026-09-09_14-22-05";
    expect(exportMediaName(take)).toBe(`export-${take}.mp4`);
    expect(exportManifestName(take)).toBe(`export-${take}.json`);
    expect(exportMediaName(take).replace(/\.mp4$/, ""))
      .toBe(exportManifestName(take).replace(/\.json$/, ""));
  });
});

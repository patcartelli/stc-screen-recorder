/**
 * The decorated still's gate (STC-291, and STC-301 gates 1 and 5).
 *
 * Asserts PROPERTIES, not pixels. Golden images were the ticket's suggestion
 * and are the wrong instrument here: gradients, blurred shadows and
 * antialiased curves are Skia's output, and CLAUDE.md already records this
 * project's pre-encode hashes differing between rasterisation backends for
 * much simpler drawing. A committed golden is a stored constant across engines
 * that the codebase does not control — it would go red on a Chromium bump
 * rather than on a regression, which is the kind of gate this project has
 * twice paid to remove.
 *
 * What it checks instead holds in any correct rasteriser:
 *
 *   - a transparent mode really is transparent OUTSIDE the window's shape, and
 *     opaque inside it, with no desktop baked behind the rounded corners;
 *   - the antialiased corner has no dark fringe — the classic premultiplied
 *     alpha mistake, which looks almost right and is the reason the acceptance
 *     list calls it out;
 *   - the shadow decreases away from the window and reaches zero;
 *   - a background covers every pixel, so a mode that promises one has no
 *     transparent hole;
 *   - canvas presets give exact dimensions with the capture centred;
 *   - and two renders of one document agree, byte for byte, inside this
 *     browser — the acceptance list's "render() stays pure", checked where it
 *     can be checked.
 *
 * It decodes no video, which is why it is the one gate in this repo immune to
 * the STC-259 decoder wedge: there is no `VideoDecoder.configure()` to block on.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { bounded, closeQuietly, STILL_MS, isBoundFailure, instrumentPage } from "./gate-bounds.mjs";

let failures = 0;
function fail(msg) { console.error(`FAIL: ${msg}`); failures++; }
function ok(msg) { console.log(`  ok  ${msg}`); }

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
});
await server.listen(5207);

// Bundled Chromium, NOT `channel: "chrome"` like the other gates. Their reason
// for real Chrome is H.264 — the bundled build has none, and every one of them
// decodes video. This gate decodes nothing, so that reason does not apply, and
// dropping it makes the gate runnable on any machine with the repo installed
// rather than only where Chrome is. Overridable for a like-for-like comparison.
//
// It costs CI a step, and the first CI run of this gate is how that was found:
// `npx playwright install chrome` fetches the CHANNEL and nothing else, so the
// bundled build was simply absent and the gate died at launch, before a single
// assertion. ci.yml installs chromium too. The browser is PRINTED rather than
// assumed, because a pixel gate whose answer depends on the rasteriser should
// never leave you guessing which one produced the answer.
const channel = process.env.STC_STILL_GATE_CHANNEL;
// An explicit binary, for an environment whose installed browsers do not match
// the Playwright version this project pins — Playwright then looks for a build
// number that is not there and reports it as "just installed or updated",
// which reads as a setup problem rather than a version skew. Naming the binary
// is the documented way out, and it costs nothing here because the gate
// asserts PROPERTIES rather than golden pixels: any correct rasteriser passes.
const executablePath = process.env.STC_STILL_GATE_BROWSER;
const browser = await chromium.launch({
  headless: true,
  ...(channel ? { channel } : {}),
  ...(executablePath ? { executablePath } : {}),
});
console.log(`browser: ${executablePath ?? channel ?? "bundled chromium"} ${browser.version()}`);
const page = await browser.newPage();
const trail = await instrumentPage(page);

try {
  await page.goto("http://localhost:5207/still.html");
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60_000 });

  const result = await bounded(
    page.evaluate(() => window.__stillGate()), STILL_MS, "in-page still gate");

  const { probes, repeat, fill, cornerRadius } = result;
  const by = Object.fromEntries(probes.map((p) => [p.mode, p]));

  // ── the capture survives decoration unchanged ────────────────────────────
  for (const mode of Object.keys(by)) {
    const p = by[mode];
    const { r, g, b, a } = p.interior;
    if (a !== 255) fail(`${mode}: the window's interior is not opaque (alpha ${a})`);
    else if (Math.abs(r - fill.r) > 2 || Math.abs(g - fill.g) > 2 || Math.abs(b - fill.b) > 2) {
      fail(`${mode}: the window's interior is ${r},${g},${b}, not the captured ${fill.r},${fill.g},${fill.b}` +
           " — decoration must not tint the capture");
    }
  }
  ok("every mode leaves the captured pixels exactly as they arrived");

  // ── annotations over a transparent mode (STC-295) ────────────────────────
  //
  // The ticket's fourth acceptance criterion: "annotations composite correctly
  // over transparent output modes, with no halo where an arrow crosses the
  // window edge." A halo is a ring of partly-transparent pixels whose colour is
  // NEITHER the accent nor what is behind — which is exactly what an outline
  // stroke under the arrow produces against nothing. There is no outline, so
  // this asserts the property that absence buys.
  {
    const p = by["window-only+annotations"];
    if (!p) fail("no annotated probe — the harness stopped rendering one");
    if (!p.alpha) fail("window-only+annotations: the output lost its alpha");
    const cross = p.arrowCross ?? [];
    if (cross.length === 0) fail("window-only+annotations: no cross-section through the arrow");

    // The arrow really is drawn out there, over nothing. Without this the rest
    // is vacuous: a pass that drew no arrow at all has no halo either.
    const painted = cross.filter((q) => q.a > 8);
    if (painted.length === 0) {
      fail("window-only+annotations: the cross-section found no arrow at all — " +
           "either it was not drawn over the transparent corner, or the sample missed it");
    }
    ok(`the arrow is drawn over the window's transparent corner (${painted.length} pixels)`);

    // Every painted pixel is the accent or an antialiased blend of it. A halo
    // shows up as a mid-alpha pixel whose hue is something else entirely.
    const accent = { r: 0xe8, g: 0x45, b: 0x2c };
    const worst = painted
      .map((q) => ({ q, d: Math.max(Math.abs(q.r - accent.r), Math.abs(q.g - accent.g),
                                    Math.abs(q.b - accent.b)) }))
      .sort((x, y) => y.d - x.d)[0];
    if (worst.d > 24) {
      fail(`window-only+annotations: a pixel on the arrow is ${worst.q.r},${worst.q.g},${worst.q.b} ` +
           `at alpha ${worst.q.a}, ${worst.d} from the accent — that is a halo, ` +
           "which means something is being drawn under the stroke");
    } else {
      ok(`no halo: every pixel on the arrow is within ${worst.d} of the accent`);
    }

    // And the stroke has an edge rather than being a hard-clipped block: some
    // pixel is partially transparent. A pass that produced only 0 or 255 would
    // mean the arrow was composited against something opaque first.
    if (!painted.some((q) => q.a > 8 && q.a < 248)) {
      fail("window-only+annotations: the arrow has no antialiased edge over transparency — " +
           "it was composited onto something opaque before it got here");
    }
    ok("the arrow keeps a real antialiased edge over transparency");
  }

  // ── modes 2 and 3: genuinely transparent ─────────────────────────────────
  for (const mode of ["window-only", "window-shadow"]) {
    const p = by[mode];
    if (!p.alpha) fail(`${mode}: layout says the output is opaque; it must keep alpha`);
    const c = p.outsideCorner;
    if (mode === "window-only") {
      // Nothing at all may be outside the shape.
      if (c.a !== 0) {
        fail(`window-only: alpha ${c.a} just outside the rounded corner — ` +
             "desktop pixels are baked in behind the window");
      }
    } else {
      // window-shadow legitimately has SHADOW there. What must not be there is
      // the capture: a corner still carrying the window's own colour means the
      // rounded shape was squared off and the pixels behind it kept.
      const looksLikeCapture = Math.abs(c.r - fill.r) < 24
                            && Math.abs(c.g - fill.g) < 24
                            && Math.abs(c.b - fill.b) < 24 && c.a > 32;
      if (looksLikeCapture) {
        fail(`window-shadow: the pixel outside the rounded corner is the capture's own ` +
             `colour (${c.r},${c.g},${c.b} at alpha ${c.a}) — the corner was squared off`);
      }
    }
  }
  if (by["window-only"].canvasCorner.a !== 0) {
    fail(`window-only: the canvas corner has alpha ${by["window-only"].canvasCorner.a}`);
  }
  ok("window-only and window-shadow are transparent outside the window's real shape");

  // ── the fringe ───────────────────────────────────────────────────────────
  // A premultiplied-alpha mistake darkens partially transparent edge pixels
  // toward black. Read back un-premultiplied, a correct edge keeps the fill's
  // own colour at every alpha; a wrong one slides toward 0,0,0.
  for (const mode of ["window-only", "window-shadow"]) {
    const p = by[mode];
    if (p.fringe.length === 0) {
      fail(`${mode}: no antialiased pixels found on the corner curve — ` +
           `the capture may not have a ${cornerRadius}px radius, so this check proved nothing`);
      continue;
    }
    const worst = p.fringe.reduce((acc, q) => {
      const d = Math.max(Math.abs(q.r - fill.r), Math.abs(q.g - fill.g), Math.abs(q.b - fill.b));
      return d > acc.d ? { d, q } : acc;
    }, { d: 0, q: null });
    if (worst.d > 24) {
      fail(`${mode}: corner fringe drifts ${worst.d} from the fill ` +
           `(${worst.q.r},${worst.q.g},${worst.q.b} at alpha ${worst.q.a}) — a dark halo`);
    }
  }
  ok(`the corner curve carries the fill's colour at every alpha (no dark halo)`);

  // ── the shadow ───────────────────────────────────────────────────────────
  {
    const ray = by["window-shadow"].shadowRay;
    if (ray.length < 4) fail(`window-shadow: only ${ray.length} samples below the window`);
    else {
      if (ray[ray.length - 1] !== 0) {
        fail(`window-shadow: alpha ${ray[ray.length - 1]} at the canvas edge — ` +
             "the shadow does not fall to zero");
      }
      if (!(ray[0] > 0)) fail("window-shadow: no shadow immediately below the window");
      // Monotone outward, allowing for the blur's own noise floor.
      let rises = 0;
      for (let i = 1; i < ray.length; i++) if (ray[i] > ray[i - 1] + 1) rises++;
      if (rises > 0) fail(`window-shadow: alpha rises ${rises} times going away from the window`);
      ok(`the shadow decreases from ${ray[0]} to 0 over ${ray.length} samples`);
    }
    // A shadow drawn OVER the window instead of under it would darken it; the
    // interior check above already covers that, and this states it.
    if (by["window-shadow"].interior.a !== 255) fail("window-shadow: the window itself is not opaque");
  }

  // ── backgrounds cover ────────────────────────────────────────────────────
  for (const mode of ["window-shadow-background", "window-shadow-custom-background"]) {
    const p = by[mode];
    if (p.alpha) fail(`${mode}: layout claims alpha, but a background fills every pixel`);
    if (!p.fullyOpaque) fail(`${mode}: some pixel is not opaque — the background has a hole`);
    if (p.canvasCorner.a !== 255) fail(`${mode}: the canvas corner is not covered`);
  }
  ok("both background modes cover every pixel");

  // ── canvas presets ───────────────────────────────────────────────────────
  for (const [preset, ratio] of [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1]]) {
    const p = by[`window-only@${preset}`];
    const actual = p.canvas.width / p.canvas.height;
    if (Math.abs(actual - ratio) > 0.01) {
      fail(`${preset}: canvas is ${p.canvas.width}x${p.canvas.height} (${actual.toFixed(3)}), not ${ratio.toFixed(3)}`);
    }
    if (p.content.width < 480 || p.content.height < 320) {
      fail(`${preset}: the capture was scaled down to ${p.content.width}x${p.content.height}`);
    }
    const dx = p.content.x - (p.canvas.width - p.content.width) / 2;
    const dy = p.content.y - (p.canvas.height - p.content.height) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) fail(`${preset}: the capture is not centred`);
  }
  ok("16:9, 4:3 and 1:1 are exact, with the capture centred and unscaled");

  // ── determinism ──────────────────────────────────────────────────────────
  if (repeat.first !== repeat.second) {
    fail(`two renders of one document differ: ${repeat.first} vs ${repeat.second}`);
  } else {
    ok(`two renders of one document are identical (${repeat.first})`);
  }

  console.log("");
  console.log(failures === 0 ? "STILL GATE: PASS" : `STILL GATE: FAIL (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  // A bound firing is the MACHINE, and is announced as such so gate-retry can
  // tell it from a wrong answer. Everything else is this gate's own failure.
  if (isBoundFailure(e)) {
    console.error(`ENVIRONMENT: ${e.message}`);
    trail.dump();
  } else {
    console.error(`FAIL: ${e?.stack ?? e}`);
  }
  process.exitCode = 1;
} finally {
  await closeQuietly(browser, server);
}

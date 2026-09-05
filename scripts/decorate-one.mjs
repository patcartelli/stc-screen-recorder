/**
 * Render a real shot in every output mode, to files a person can look at.
 *
 * The gate proves properties — alpha is zero outside the shape, the shadow
 * falls to zero — and none of that answers the only question the presets
 * actually have to pass, which is whether the result looks like a product
 * shot. STC-291 says the values can only be chosen by making figures with
 * them; this is the thing that makes the figures.
 *
 * Usage: node scripts/decorate-one.mjs <shotDir> [outDir]
 *
 * `shotDir` is a directory holding `shot.json` and its frame — one of the
 * folders `capture-still` writes. Output lands beside it as
 * `decorated-<mode>.png` unless another directory is given.
 *
 * Sibling of scripts/export-one.mjs, which does the same job for video, and
 * carries the same warning: an artifact made for human verification is only
 * worth looking at if it came from the take's OWN document. This one edits
 * only the mode, and takes every other parameter from the file.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const shotDir = process.argv[2];
const outDir = process.argv[3] || shotDir;
if (!shotDir || !existsSync(join(shotDir, "shot.json"))) {
  console.error("usage: node scripts/decorate-one.mjs <shotDir> [outDir]");
  console.error("  <shotDir> must hold shot.json and its frame");
  process.exit(2);
}

const shot = JSON.parse(readFileSync(join(shotDir, "shot.json"), "utf8"));
const framePath = join(shotDir, shot.frame?.file ?? "frame.png");
if (!existsSync(framePath)) {
  console.error(`no ${basename(framePath)} in ${shotDir}`);
  process.exit(2);
}
// As a data URL: the page is served by vite from harness/, and the shot lives
// wherever the user's shots live. Inlining avoids inventing a second route
// just so a one-off tool can read one file.
const frameSrc = `data:image/png;base64,${readFileSync(framePath).toString("base64")}`;

// A window shot can wear all five; a display crop only ever means the first,
// because the other four need the window's own alpha and it has none.
const MODES = shot.kind === "window"
  ? ["selected-area", "window-only", "window-shadow",
     "window-shadow-background", "window-shadow-custom-background"]
  : ["selected-area"];

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
});
await server.listen(5208);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5208/still.html");
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60_000 });

  for (const mode of MODES) {
    const started = Date.now();
    const dataUrl = await page.evaluate(
      ([s, f, m]) => window.__decorate(s, f, m), [shot, frameSrc, mode]);
    const png = Buffer.from(dataUrl.split(",")[1], "base64");
    const dest = join(outDir, `decorated-${mode}.png`);
    writeFileSync(dest, png);
    console.log(`  ${mode.padEnd(32)} ${String(Date.now() - started).padStart(5)} ms  ` +
                `${(png.length / 1024).toFixed(0)} KB  -> ${dest}`);
  }
  console.log("");
  console.log("Open them. The gate says these are correct; only looking says they are good.");
  if (shot.kind !== "window") {
    console.log("NB a display crop has no alpha, so only selected-area applies to it —");
    console.log("   the other four modes need a WINDOW capture's real corners.");
  }
} finally {
  await browser.close().catch(() => {});
  await server.close();
}

/**
 * Export a session to a watchable file. Unlike the gate — which compares hashes
 * and discards the bytes — this writes the encoded MP4 next to the session so a
 * human can look at it. Structural checks prove the sinks agree; only watching
 * proves the cursor lands where it belongs.
 *
 * Usage: node scripts/export-one.mjs <sessionDir> [seconds]
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sessionDir = process.argv[2];
const seconds = Number(process.argv[3] ?? 10);
const fromSeconds = Number(process.argv[4] ?? 0);
if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("usage: node scripts/export-one.mjs <sessionDir> [seconds] [fromSeconds]");
  process.exit(2);
}
const anchors = JSON.parse(readFileSync(join(sessionDir, "anchors.json"), "utf8"));

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  // HMR reloads the page when vite re-optimises deps, destroying any in-flight
  // evaluate ("resulting promise was garbage collected").
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{
    name: "serve-session",
    configureServer(s) {
      s.middlewares.use("/session", (req, res, next) => {
        const name = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!["anchors.json", "events.json", "project.json", "display.mp4", "camera.mp4"].includes(name)) return next();
        res.setHeader("content-type", name.endsWith(".json") ? "application/json" : "video/mp4");
        res.end(readFileSync(join(sessionDir, name)));
      });
    },
  }],
});
await server.listen(5201);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e)));
let out = 1;
try {
  await page.goto("http://localhost:5201/export.html");
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
  const project = {
    version: 1,
    output: { fps: 60, width: anchors.capture.width, height: anchors.capture.height },
    cursor: { style: "default", scale: 1 },
  };
  const frames = Math.round(seconds * 60);
  const fromFrame = Math.round(fromSeconds * 60);
  console.log(`exporting ${seconds}s from t=${fromSeconds}s (${frames} frames) ` +
              `at ${project.output.width}x${project.output.height}…`);
  const r = await page.evaluate(([p, f, ff]) =>
    window.exportSession("/session", p, { maxFrames: f, fromFrame: ff, encode: true, returnFile: true }),
    [project, frames, fromFrame]);

  const dest = join(sessionDir, `export-${seconds}s-from${fromSeconds}s.mp4`);
  writeFileSync(dest, Buffer.from(r.encodedBase64, "base64"));
  console.log(`\n${r.frames} frames in ${(r.durationMs / 1000).toFixed(1)}s`);
  console.log(`wrote ${dest} (${(r.encodedBytes / 1e6).toFixed(2)} MB)`);
  out = 0;
} catch (e) {
  console.error("FAILED:", String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
process.exit(out);

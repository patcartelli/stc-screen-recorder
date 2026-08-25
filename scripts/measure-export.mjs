/**
 * Increment 0 of phase 2: how fast is a REAL export, as opposed to a gated one?
 *
 * The gate pays a 33 MB getImageData and a SHA-256 per frame to compare sinks.
 * An export in the app pays neither. The difference decides whether the UI can
 * offer a progress bar or must offer a background job.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sessionDir = process.argv[2];
const seconds = Number(process.argv[3] ?? 15);
if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("usage: node scripts/measure-export.mjs <sessionDir> [seconds]");
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
        if (!["anchors.json", "events.json", "display.mp4"].includes(name)) return next();
        res.setHeader("content-type", name.endsWith(".json") ? "application/json" : "video/mp4");
        res.end(readFileSync(join(sessionDir, name)));
      });
    },
  }],
});
await server.listen(5202);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e)));
try {
  await page.goto("http://localhost:5202/export.html");
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
  const project = {
    version: 1,
    output: { fps: 60, width: anchors.capture.width, height: anchors.capture.height },
    cursor: { style: "default", scale: 1 },
  };
  const frames = Math.round(seconds * 60);
  const run = (hash) => page.evaluate(([p, f, h]) =>
    window.exportSession("/session", p, { maxFrames: f, encode: true, hash: h }), [project, frames, hash]);

  console.log(`${project.output.width}x${project.output.height}, ${frames} frames (${seconds}s of output)\n`);
  const gated = await run(true);
  console.log(`with hash (gate path):  ${(gated.durationMs / 1000).toFixed(1)}s  ` +
              `= ${(gated.durationMs / gated.frames).toFixed(1)} ms/frame`);
  const real = await run(false);
  console.log(`without hash (export):  ${(real.durationMs / 1000).toFixed(1)}s  ` +
              `= ${(real.durationMs / real.frames).toFixed(1)} ms/frame`);

  const speedup = gated.durationMs / real.durationMs;
  const realtime = (seconds * 1000) / real.durationMs;
  console.log(`\nhashing accounts for ${((1 - 1 / speedup) * 100).toFixed(0)}% of gate time (${speedup.toFixed(1)}x)`);
  console.log(`real export runs at ${realtime.toFixed(2)}x realtime ` +
              `(a 5-minute take would take ${(300 / realtime / 60).toFixed(1)} minutes)`);
  console.log(`\nverdict: ${realtime >= 1 ? "faster than realtime — a progress bar is honest"
                                          : "slower than realtime — the UI must not pretend it is quick"}`);
} catch (e) {
  console.error("FAILED:", String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}

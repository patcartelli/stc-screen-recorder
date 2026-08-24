/**
 * Phase 2 increment 2 gate: the seeking frame source must return the frame it
 * was asked for, in any order, without leaking or thrashing.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  // HMR reloads the page when vite re-optimises deps, destroying any in-flight
  // evaluate. Nothing here needs live reload.
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{ name: "fixture", configureServer(s) {
    s.middlewares.use("/fixture.mp4", (_req, res) => {
      res.setHeader("content-type", "video/mp4");
      res.end(readFileSync(new URL("../fixtures/basic/display.mp4", import.meta.url).pathname));
    });
  }}],
});
await server.listen(5204);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("crash", () => errors.push("RENDERER CRASHED"));
const probes = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("SEEKGATE probe")) { probes.push(t); return; }
  if (m.type() === "error") errors.push(t);
});

let failed = false;
const fail = (m) => { failed = true; console.error("FAIL:", m); };
try {
  // Vite pre-bundles dependencies on first load and RELOADS the page when it
  // does, which destroys any in-flight evaluate ("resulting promise was garbage
  // collected") before a single probe runs. Load once to trigger that, then
  // reload deliberately so the page we evaluate against is settled.
  await page.goto("http://localhost:5204/seek.html");
  await page.waitForFunction(() => window.__seekReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__seekReady === true, { timeout: 60_000 });
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      r = await Promise.race([
        page.evaluate(() => window.runSeekGate("/fixture.mp4")),
        new Promise((_, rej) => setTimeout(() => rej(new Error(
          `timed out; last probe: ${probes[probes.length - 1] ?? "none"} (after ${probes.length} probes)`)), 90_000)),
      ]);
      break;
    } catch (e) {
      if (attempt === 3 || !String(e).includes("garbage collected")) throw e;
      console.log(`  (page context was replaced mid-run; retry ${attempt})`);
      await page.waitForFunction(() => window.__seekReady === true, { timeout: 60_000 });
    }
  }

  if (r.fatal) { fail(`page threw: ${r.fatal}`); throw new Error("see above"); }
  if (r.stuckOnFirstSeek) {
    fail("frameAt(0) never resolved. Source state:");
    console.error("   ", JSON.stringify(r.debug, null, 2).split("\n").join("\n    "));
    throw new Error("see above");
  }
  console.log(`fixture: ${r.frames} frames`);
  console.log(`seek accuracy: ${r.failures.length === 0 ? "every seek returned the requested frame"
                                                        : `${r.failures.length} wrong`}`);
  for (const f of r.failures.slice(0, 8)) console.error("   ", f);
  if (r.failures.length) fail(`${r.failures.length} seeks returned the wrong frame`);

  console.log(`\nscrub: ${r.scrubSuperseded}/39 earlier requests superseded, ` +
              `last resolved frame ${r.scrubLastIndex} (wanted ${r.scrubExpected})`);
  if (r.scrubLastIndex !== r.scrubExpected) fail("a scrub did not honour its final request");
  if (r.scrubSuperseded === 0) fail("no request was superseded — requests are not being coalesced");

  console.log(`peak buffered frames: ${r.peakBuffered}`);
  if (r.peakBuffered > 24) fail(`peak buffered ${r.peakBuffered} — frames are accumulating`);

  console.log(`decoder generations: ${r.decoderGenerations} (one per backward/cross-GOP seek)`);
  if (r.decoderGenerations > 200) fail("decoder is being rebuilt far too often — reset thrashing");

  console.log(`live frames after close(): ${r.liveFramesAfterClose}`);
  if (r.liveFramesAfterClose !== 0) fail("frames leaked past close()");
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  if (errors.length) { console.error("--- page errors ---"); errors.slice(0, 5).forEach((e) => console.error(" ", e)); }
  await browser.close(); await server.close();
}
console.log(failed ? "\nSEEK GATE: FAIL" : "\nSEEK GATE: PASS");
process.exit(failed ? 1 : 0);

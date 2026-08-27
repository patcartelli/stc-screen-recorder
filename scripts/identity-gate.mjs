/**
 * Phase 2 increment 3 gate: preview and export must produce identical pixels
 * at the same t. Same render(), same compositor — only the frame source
 * differs, and the seeking source is visited in a jumbled order because that
 * is what a scrub actually does.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function newestSession() {
  const root = process.env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc");
  if (!existsSync(root)) return undefined;
  return readdirSync(root).map((n) => join(root, n))
    .filter((p) => existsSync(join(p, "display.mp4"))).sort().pop();
}
const sessionDir = process.argv[2] || newestSession();
// The design spec states the PiP determinism claim at 200 sampled t; the
// default stays 60 for the slower real-take runs.
const SAMPLES = Number(process.env.STC_IDENTITY_SAMPLES ?? 60);
if (!sessionDir) { console.error("no session found; record one or pass a directory"); process.exit(2); }
console.log(`session: ${sessionDir}`);

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{ name: "session", configureServer(s) {
    s.middlewares.use("/session", (req, res, next) => {
      const n = (req.url || "").split("?")[0].replace(/^\//, "");
      // camera.mp4 and project.json are on this list deliberately. Left off,
      // they fall through to vite, the page's fetch resolves with vite's HTML,
      // r.json() throws, and the take loads camera-less — a clean PASS that
      // tested nothing.
      if (!["anchors.json", "events.json", "project.json", "display.mp4", "camera.mp4"].includes(n)) return next();
      const f = join(sessionDir, n);
      // A camera-less take genuinely has no camera.mp4, and the page only asks
      // for it when anchors.files.camera is set — so a miss here means the
      // anchors and the directory disagree, which is worth failing loudly on.
      if (!existsSync(f)) { res.statusCode = 404; res.end(`no ${n} in this take`); return; }
      res.setHeader("content-type", n.endsWith(".json") ? "application/json" : "video/mp4");
      res.end(readFileSync(f));
    });
  }}],
});
await server.listen(5205);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failed = false;
const fail = (m) => { failed = true; console.error("FAIL:", m); };
try {
  await page.goto("http://localhost:5205/sink-identity.html");
  await page.waitForFunction(() => window.__identityReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__identityReady === true, { timeout: 60_000 });

  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { r = await page.evaluate((n) => window.runSinkIdentity("/session", n), SAMPLES); break; }
    catch (e) {
      if (attempt === 3 || !String(e).includes("garbage collected")) throw e;
      await page.waitForFunction(() => window.__identityReady === true, { timeout: 60_000 });
    }
  }
  if (r.fatal) { fail(`page threw: ${r.fatal}`); throw new Error("see above"); }

  console.log(`\n${r.samples} sampled t across ${r.totalOut} output frames`);
  console.log(`export order: ascending    preview order: shuffled`);
  console.log(`mismatches: ${r.mismatches.length}`);
  for (const m of r.mismatches.slice(0, 8)) console.error("   ", m);
  if (r.mismatches.length) fail(`${r.mismatches.length} frames differ between preview and export`);
  console.log(`seeking source: peak buffered ${r.peakBuffered}, decoder generations ${r.decoderGenerations}`);

  console.log(`camera track present: ${r.cameraPresent}`);
  if (r.cameraPresent) {
    console.log(`PiP: ${r.pipFrames} of ${r.samples} sampled frames have one, drawn on ${r.pipDrawnFrames}`);
    if (r.pipFrames === 0) {
      fail("a camera track loaded but render() gave no PiP on any sampled frame — " +
           "check project.pip.enabled and the anchors.camera bounds");
    } else if (r.pipDrawnFrames === 0) {
      fail("the PiP has geometry on every sampled frame but no camera frame was ever " +
           "decoded — the sinks are not driving the camera decoder");
    }
    // THE check the hashes cannot make. Preview-vs-export identity holds
    // perfectly when BOTH sinks ignore the camera, so the only way to prove a
    // PiP was drawn at all is to composite the same frame with it suppressed
    // and require the two to differ.
    if (r.pipBlindMismatches > 0) {
      fail(`${r.pipBlindMismatches} of ${r.pipFrames} PiP frames are byte-identical with the ` +
           `PiP suppressed — the camera is being decoded and then discarded`);
    } else {
      console.log(`PiP actually changes the pixels on all ${r.pipFrames} frames that have one`);
    }
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  if (errors.length) { console.error("--- page errors ---"); errors.slice(0, 5).forEach((e) => console.error(" ", e)); }
  await browser.close(); await server.close();
}
console.log(failed ? "\nIDENTITY GATE: FAIL" : "\nIDENTITY GATE: PASS");
process.exit(failed ? 1 : 0);

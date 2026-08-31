/**
 * Increment 4 gate: export a REAL recorded session twice, independently, and
 * require the pre-encode hashes to match.
 *
 * Encoded MP4 bytes are deliberately not compared — container timestamps and
 * encoder state are not contractually deterministic. The gate lives before the
 * encoder, where determinism is actually promised.
 *
 * Usage: node scripts/export-gate.mjs [sessionDir] [maxFrames]
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { SOFTWARE_RENDER_ARGS, forceSoftwareRender } from "./render-backend.mjs";
import { bounded, closeQuietly, EVAL_MS, isBoundFailure, instrumentPage } from "./gate-bounds.mjs";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function newestSession() {
  const root = process.env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc");
  if (!existsSync(root)) return undefined;
  const takes = readdirSync(root)
    .map((n) => join(root, n))
    .filter((p) => existsSync(join(p, "display.mp4")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return takes[0];
}

const sessionDir = process.argv[2] || newestSession();
const maxFrames = process.argv[3] ? Number(process.argv[3]) : undefined;

if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("no session found. Record one, or pass a directory:\n" +
                "  node scripts/export-gate.mjs ~/Desktop/stc/<take>");
  process.exit(2);
}

const anchors = JSON.parse(readFileSync(join(sessionDir, "anchors.json"), "utf8"));
console.log(`session: ${sessionDir}`);
console.log(`capture: ${anchors.capture.width}x${anchors.capture.height}`);

const server = await createServer({
  configFile: false,
  root: "harness",
  publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  // HMR reloads the page when vite re-optimises deps, destroying any in-flight
  // evaluate ("resulting promise was garbage collected"). Nothing here needs it.
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{
    name: "serve-session",
    configureServer(s) {
      s.middlewares.use("/session", (req, res, next) => {
        const name = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!["anchors.json", "events.json", "project.json", "display.mp4", "camera.mp4"].includes(name)) return next();
        const body = readFileSync(join(sessionDir, name));
        res.setHeader("content-type", name.endsWith(".json") ? "application/json" : "video/mp4");
        res.end(body);
      });
    },
  }],
});
await server.listen(5200);

// The pre-encode hash depends on the rasterization backend; see
// scripts/render-backend.mjs. This gate's own comparisons all happen inside
// this one browser and are unaffected, so it only pins when a caller comparing
// against ANOTHER engine asks it to.
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  ...(forceSoftwareRender() ? { args: SOFTWARE_RENDER_ARGS } : {}),
});
const page = await browser.newPage();
// STC-259 Mode B: a blocked renderer kills every in-page bound, so the page's
// checkpoints are collected out here. Also installs the wedge fault injection.
const trail = await instrumentPage(page);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

let failed = false;
const fail = (m) => { failed = true; console.error("FAIL:", m); };
/**
 * The machine declined, as distinct from this gate finding a wrong answer.
 * Both fail the run; only the LABEL differs, and gate-retry keys on it —
 * ENVIRONMENT is skippable, FAIL: never is.
 */
const environment = (m) => {
  failed = true;
  console.error("ENVIRONMENT:", m);
  // Every ENVIRONMENT path dumps the trail, rather than the catch site doing it
  // — seek-gate reaches this from its own stuckOnFirstSeek branch too, and a
  // diagnosis wired per call site is one that gets forgotten at the next one.
  trail.dump();
};

try {
  await page.goto("http://localhost:5200/export.html");
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });

  // The take's OWN project.json, passed THROUGH untouched — the page decides
  // defaults with parseProject, the same function the app uses.
  //
  // Hardcoding a default here was harmless while nothing in a project could
  // change the output, and then trim arrived: with a trimmed project on disk
  // the app exported a clip while this side exported the whole take, and the
  // identity gate compared two different things and called it a mismatch. The
  // PiP repeated it — a camera take with no project.json previewed WITH a PiP
  // and exported without one. Assembling a project outside the one parser is
  // how those two answers happen.
  const projectPath = join(sessionDir, "project.json");
  const project = existsSync(projectPath)
    ? JSON.parse(readFileSync(projectPath, "utf8"))
    : null;
  console.log(project
    ? `project.json found: pip=${JSON.stringify(project.pip ?? null)} trim=${JSON.stringify(project.trim ?? null)}`
    : "no project.json — the page applies defaults (PiP on for a camera take)");

  // Vite may still reload once while pre-bundling; retry rather than fail.
  const withRetry = async (fn) => {
    for (let a = 1; a <= 3; a++) {
      try { return await fn(); }
      catch (e) {
        if (a === 3 || !String(e).includes("garbage collected")) throw e;
        await page.waitForFunction(() => window.__exportReady === true, { timeout: 60_000 });
      }
    }
  };

  // Bounds the evaluate, NOT the retry loop: a retry that re-enters an
  // unbounded wait is not bounded, it is three unbounded waits.
  const runOne = (mf) => withRetry(() => bounded(page.evaluate(
    ([p, mfr]) => window.exportSession("/session", p, { maxFrames: mfr ?? undefined, encode: true }),
    [project, mf ?? null]), EVAL_MS, "the in-page export run (decode, render, encode)"));

  console.log("\nexport run A…");
  const a = await runOne(maxFrames);
  console.log(`  ${a.frames} frames in ${(a.durationMs / 1000).toFixed(1)}s ` +
              `(decoded ${a.decodedFrames}, peak buffered ${a.peakBufferedFrames}), ` +
              `encoded ${(a.encodedBytes / 1e6).toFixed(2)} MB`);

  console.log("export run B…");
  const b = await runOne(maxFrames);
  console.log(`  ${b.frames} frames in ${(b.durationMs / 1000).toFixed(1)}s`);

  console.log(`\nhash A: ${a.hash}`);
  console.log(`hash B: ${b.hash}`);
  if (a.hash !== b.hash) fail("two independent exports produced different pre-encode hashes");
  if (a.frames !== b.frames) fail(`frame counts differ: ${a.frames} vs ${b.frames}`);
  if (!(a.encodedBytes > 0)) fail("encoder produced no bytes");

  // Memory: streaming means the buffered set stays bounded by the decoder's
  // queue target, NOT by the length of the recording. The 60 s take peaked at
  // 16 against 3414 source frames, which is the property being asserted — but
  // 16 sat exactly on the old limit of >16, one frame from a spurious failure.
  // The threshold exists to catch "decodes everything", so give it headroom.
  const BOUNDED = 48;
  if (a.peakBufferedFrames > BOUNDED) {
    fail(`peak buffered frames ${a.peakBufferedFrames} > ${BOUNDED} — the source is not streaming`);
  }
  if (a.peakBufferedFrames >= a.decodedFrames && a.decodedFrames > BOUNDED) {
    fail("every decoded frame was retained — that is decode-all, not streaming");
  }
  console.log(`\npeak buffered frames: ${a.peakBufferedFrames} (bounded, not proportional to length)`);
} catch (e) {
  // A bound firing means the machine did not service the pipeline; anything
  // else thrown here is ours. Asked of the error, not matched against its text.
  if (isBoundFailure(e)) environment(String(e?.stack ?? e));
  else fail(String(e?.stack ?? e));
} finally {
  if (errors.length) { console.error("--- page errors ---"); errors.forEach((e) => console.error(" ", e)); }
  await closeQuietly(browser, server);
}
console.log(failed ? "\nEXPORT GATE: FAIL" : "\nEXPORT GATE: PASS");
process.exit(failed ? 1 : 0);

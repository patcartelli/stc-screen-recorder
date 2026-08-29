/**
 * Phase 2 increment 2 gate: the seeking frame source must return the frame it
 * was asked for, in any order, without leaking or thrashing.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { closeQuietly, isBoundFailure } from "./gate-bounds.mjs";
import { classifyDecoderStall } from "./decoder-stall.mjs";

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
/**
 * The machine declined, as distinct from this gate finding a wrong answer.
 *
 * Both still fail the run; only the LABEL differs, and gate-retry keys on that
 * label alone — ENVIRONMENT is skippable, FAIL: never is. Until this existed,
 * a decoder that accepted chunks and emitted none reddened PRs wearing the code
 * label, twice in one night on CI run 33228579869.
 */
const environment = (m) => { failed = true; console.error("ENVIRONMENT:", m); };
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
  // A label nobody has watched being applied is the same trap as a bound nobody
  // has watched fire. Both paths are reachable on demand so the tests assert
  // against observed behaviour, not against code that reads as though it works.
  if (process.env.STC_SEEK_FAULT === "machine") {
    r = { stuckOnFirstSeek: true, debug: {
      decoderState: "configured", decodeQueueSize: 8, pending: 0, nextFeed: 8,
      nextOutIndex: 0, currentIndex: -1, needsKeyframe: false, failure: null, waiting: true,
    } };
  }
  if (process.env.STC_SEEK_FAULT === "ours") {
    // Same symptom, our fault: nothing was ever submitted to the decoder.
    r = { stuckOnFirstSeek: true, debug: {
      decoderState: "configured", decodeQueueSize: 0, pending: 0, nextFeed: 0,
      nextOutIndex: 0, currentIndex: -1, needsKeyframe: false, failure: null, waiting: true,
    } };
  }

  if (r.stuckOnFirstSeek) {
    // Which of the two this is comes from the source's own STATE, never from
    // the text of a message: fed-configured-silent is the machine, anything
    // else is ours. Labelling the whole branch ENVIRONMENT would let a broken
    // SeekingFrameSource skip quietly, and a skip that absorbs a regression is
    // worse than no skip at all.
    const verdict = classifyDecoderStall(r.debug);
    const say = verdict === "machine" ? environment : fail;
    say(verdict === "machine"
      ? "the decoder accepted chunks and emitted none — frameAt(0) never resolved. Source state:"
      : "frameAt(0) never resolved, and the source state says this is OURS. Source state:");
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
  const msg = String(e?.stack ?? e);
  // `see above` means a branch above already labelled it and printed the
  // detail; re-reporting here would overwrite ENVIRONMENT with FAIL: and undo
  // the distinction this file just made.
  if (/see above/.test(msg)) { /* already labelled and printed above */ }
  else if (isBoundFailure(e)) environment(msg);
  else fail(msg);
} finally {
  if (errors.length) { console.error("--- page errors ---"); errors.slice(0, 5).forEach((e) => console.error(" ", e)); }
  // Bounded. Closing a browser whose renderer is wedged never returns, and this
  // runs in `finally` — so an unbounded close holds the CI job to its cap and
  // reports as "cancelled", burying the real error above it. That is STC-259's
  // 26-minute "stall", and it happened here again on 2026-08-28: this gate
  // failed correctly in 10 s with a full decoder dump, then held the job for
  // 17.5 more minutes. #30 fixed the other three gates and missed this one.
  await closeQuietly(browser, server);
}
console.log(failed ? "\nSEEK GATE: FAIL" : "\nSEEK GATE: PASS");
process.exit(failed ? 1 : 0);

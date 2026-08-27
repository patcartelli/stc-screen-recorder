/**
 * Renderer RSS while previewing a take, with and without its camera track.
 *
 * PHASE-2 measured "458 MB take -> +548 MB renderer RSS (~1.2x)" for a
 * display-only take, but that measurement was ad hoc and never committed, so
 * the number could not be reproduced when a second decoder arrived. This is
 * the harness, so the next person changing preview memory can re-run it.
 *
 * RSS via app.getAppMetrics(), NEVER performance.memory.usedJSHeapSize —
 * ArrayBuffers live outside V8's heap, so a 458 MB take reported as "~0 MB
 * heap growth". A metric that cannot see the thing being measured produces
 * confident numbers about nothing.
 *
 * Usage: node scripts/measure-preview-memory.mjs <takeDir>
 */
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const root = join(import.meta.dirname, "..");
const src = process.argv[2];
if (!src || !existsSync(join(src, "anchors.json"))) {
  console.error("usage: node scripts/measure-preview-memory.mjs <takeDir>");
  process.exit(2);
}

const mb = (bytes) => Math.round(bytes / 1e6);

/** Copies the take into a private recordings dir, optionally stripping the camera. */
function stage(withCamera) {
  const dir = mkdtempSync(join(tmpdir(), "stc-mem-"));
  const takeDir = join(dir, basename(src));
  mkdirSync(takeDir, { recursive: true });
  const files = ["anchors.json", "events.json", "display.mp4", "project.json"];
  if (withCamera) files.push("camera.mp4");
  for (const f of files) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(takeDir, f));
  }
  if (!withCamera) {
    // The anchors must agree with the directory: loadSession refuses a claimed
    // camera with no file, which is the whole point of that check.
    const a = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
    if (a.camera) a.camera.present = false;
    if (a.files) delete a.files.camera;
    writeFileSync(join(takeDir, "anchors.json"), JSON.stringify(a, null, 2));
    const pPath = join(takeDir, "project.json");
    if (existsSync(pPath)) {
      const p = JSON.parse(readFileSync(pPath, "utf8"));
      if (p.pip) p.pip.enabled = false;
      writeFileSync(pPath, JSON.stringify(p, null, 2));
    }
  }
  let bytes = 0;
  for (const f of files) if (existsSync(join(takeDir, f))) bytes += statSync(join(takeDir, f)).size;
  return { dir, bytes };
}

/** Renderer RSS in bytes. getAppMetrics reports memory in KILOBYTES. */
async function rendererRss(app) {
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const renderers = metrics.filter((m) => m.type === "Tab" || m.type === "Renderer");
  return renderers.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0) * 1024, 0);
}

async function measure(withCamera) {
  const { dir, bytes } = stage(withCamera);
  const app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector("#takes >> text=Preview", { timeout: 30_000 });
    const before = await rendererRss(app);

    await win.click("#takes >> text=Preview");
    await win.waitForSelector("#player", { state: "visible", timeout: 60_000 });
    // Wait for real pixels: RSS read before decoding starts measures nothing.
    await win.waitForFunction(() => {
      const c = document.getElementById("stage");
      if (!c) return false;
      const d = c.getContext("2d").getImageData(0, 0, 32, 32).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) return true;
      return false;
    }, { timeout: 60_000 });

    const after = await rendererRss(app);
    return { bytes, before, after, growth: after - before };
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });

const off = await measure(false);
const on = await measure(true);

const row = (label, r) =>
  `${label.padEnd(16)} ${String(mb(r.bytes) + " MB").padEnd(10)} ` +
  `${String(mb(r.before) + " -> " + mb(r.after) + " MB").padEnd(20)} ` +
  `+${mb(r.growth)} MB  (${(r.growth / r.bytes).toFixed(2)}x file)`;

console.log(`\ntake: ${src}`);
console.log(`${"".padEnd(16)} ${"files".padEnd(10)} ${"renderer RSS".padEnd(20)} growth`);
console.log(row("display only", off));
console.log(row("display+camera", on));
const extra = on.growth - off.growth;
const dBytes = statSync(join(src, "display.mp4")).size;
const cBytes = existsSync(join(src, "camera.mp4")) ? statSync(join(src, "camera.mp4")).size : 0;
console.log(`\ndisplay.mp4 ${mb(dBytes)} MB, camera.mp4 ${mb(cBytes)} MB`);
console.log(
  `camera track costs +${mb(extra)} MB of renderer RSS ` +
  `(${((extra / off.growth) * 100).toFixed(0)}% on top of display-only)`,
);

// Read the ratio in the right regime before quoting it anywhere.
//
// PHASE-2's "~1.2x file size" came from a 458 MB take, where the file itself
// dominates. On a SHORT take the fixed costs — decoder buffers and a decoded
// 4K frame at ~30 MB — dominate instead, so the ratio looks far worse while
// the absolute numbers are small. The two are not comparable, and the ceiling
// in STC-251 is about the long regime.
//
// The design spec's open risk guessed "a 720p camera adds ~10-15%". That guess
// assumed the display track dwarfs the camera. Check whether it actually does
// here before treating any percentage as a verdict.
if (cBytes >= dBytes) {
  console.log(
    `\nNOTE: camera.mp4 is ${(cBytes / dBytes).toFixed(1)}x the size of display.mp4 on this take, ` +
    `so the percentage above says more about the two FILES than about PiP overhead. ` +
    `The spec's 10-15% estimate assumed a display track that dwarfs the camera — ` +
    `which is a long 4K take, not this one.`,
  );
}
console.log(
  `\nRatios are regime-dependent: PHASE-2's ~1.2x came from a 458 MB take where the ` +
  `file dominates. This take is ${mb(off.bytes + cBytes)} MB, where fixed decoder cost does. ` +
  `Quote the absolute growth, not the multiple.`,
);

/**
 * Export one real shot through the REAL encoder, in every format, to files a
 * person can open (STC-293).
 *
 * Sibling of `scripts/decorate-one.mjs`, which stops at a browser PNG, and of
 * `scripts/export-one.mjs`, which does this job for video. The difference that
 * matters: `decorate-one.mjs` encodes with `canvas.toDataURL`, which is the
 * second encoder this ticket exists to remove. This one composites in the
 * browser and then hands raw RGBA to the helper's `export-still`, so what
 * lands on disk came out of ImageIO by the same path the app uses.
 *
 * Usage: node scripts/export-still-one.mjs <shotDir> [outDir]
 *
 * It carries the same warning its two siblings do: an artifact made for human
 * verification is only worth looking at if it came from the take's OWN
 * document. This one varies the FORMAT and takes every other parameter — the
 * decoration mode included — from `shot.json`.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const shotDir = process.argv[2];
const outDir = process.argv[3] || shotDir;
if (!shotDir || !existsSync(join(shotDir, "shot.json"))) {
  console.error("usage: node scripts/export-still-one.mjs <shotDir> [outDir]");
  console.error("  <shotDir> must hold shot.json and its frame");
  process.exit(2);
}

const BIN = new URL("../helper/build/stc-helper", import.meta.url).pathname;
if (!existsSync(BIN)) {
  console.error(`no helper at ${BIN} — run helper/build.sh first`);
  process.exit(2);
}

const shot = JSON.parse(readFileSync(join(shotDir, "shot.json"), "utf8"));
const framePath = join(shotDir, shot.frame?.file ?? "frame.png");
if (!existsSync(framePath)) {
  console.error(`no ${basename(framePath)} in ${shotDir}`);
  process.exit(2);
}
const frameSrc = `data:image/png;base64,${readFileSync(framePath).toString("base64")}`;

/** The helper, driven over its two-channel protocol, exactly as the app does. */
function helper() {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const replies = [];
  let buf = "";
  proc.stdio[3].on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { replies.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  proc.stdout.resume();
  proc.stderr.on("data", (c) => process.stderr.write(c));
  let seq = 0;
  return {
    // Bounded, like every wait in this codebase: the helper's own export
    // backstop is 30 s, so 45 leaves it room to report the step it reached
    // rather than dying anonymously here.
    request: (cmd, ms = 45_000) => new Promise((resolve, reject) => {
      const s = ++seq;
      proc.stdin.write(JSON.stringify({ ...cmd, seq: s }) + "\n");
      const started = Date.now();
      const poll = setInterval(() => {
        const r = replies.find((l) => l.seq === s);
        if (r) { clearInterval(poll); resolve(r); }
        else if (Date.now() - started > ms) {
          clearInterval(poll);
          reject(new Error(`export-still did not answer within ${ms} ms`));
        }
      }, 20);
    }),
    kill: () => proc.kill("SIGKILL"),
  };
}

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
});
await server.listen(5209);
const browser = await chromium.launch({ headless: true });
const h = helper();
const scratch = mkdtempSync(join(tmpdir(), "stc-export-one-"));

try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5209/still.html");
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60_000 });

  for (const format of ["png", "heic", "jpeg"]) {
    for (const scale of ["native", "1x"]) {
      const started = Date.now();
      // The browser composites and hands back PIXELS, never an encoded image:
      // an encoded image would mean the page had already chosen a format,
      // which is the decision this whole path exists to own.
      const composed = await page.evaluate(
        ([s, f, fmt, sc]) => window.__composite(s, f, fmt, sc), [shot, frameSrc, format, scale]);

      const rgba = join(scratch, "composite.rgba");
      writeFileSync(rgba, Buffer.from(composed.bytes, "base64"));
      const suffix = scale === "native" ? "" : "-1x";
      const dest = join(outDir, `export-${shot.decoration?.mode ?? "shot"}${suffix}.${
        format === "jpeg" ? "jpg" : format}`);

      const r = await h.request({
        cmd: "export-still", rgba, width: composed.width, height: composed.height,
        alpha: composed.alpha, colorSpace: composed.colorSpace,
        format, quality: 0.9, file: dest,
        capturedAt: new Date().toISOString(),
      });
      if (r.ev === "error") {
        console.log(`  ${format.padEnd(5)}${suffix.padEnd(4)}  FAILED  ${r.code}: ${r.detail}`);
        continue;
      }
      console.log(`  ${format.padEnd(5)}${suffix.padEnd(4)} ${String(Date.now() - started).padStart(5)} ms  `
        + `${composed.width}x${composed.height}  ${(r.bytes / 1024).toFixed(0)} KB  `
        + `alpha=${r.alpha}  ${r.colorSpace}`
        // Said out loud, because a flattened file looks like a bug otherwise:
        // the app ASKS before doing this, and a script has nobody to ask.
        + `${composed.flattened ? "  FLATTENED onto white" : ""}  -> ${dest}`);
    }
  }
  console.log("");
  console.log("Open them. Check the transparent ones over a dark background —");
  console.log("a white halo at a window's corner is a premultiply bug, not a shadow.");
} finally {
  h.kill();
  await browser.close().catch(() => {});
  await server.close();
}

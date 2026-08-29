/**
 * Camera-to-display sync, as a NUMBER.
 *
 * The design spec asks for a millisecond figure, and "looks in sync" is an
 * eye's tolerance, not a measurement. One physical event — a screen flash —
 * appears in both tracks: directly in display.mp4, and as reflected room and
 * face illumination in camera.mp4. Both tracks carry session-relative ns from
 * the same mach clock, so the gap between when each SEES the flash is the
 * camera's latency relative to the display.
 *
 * NOT scratch/avsync.cjs: that measures camera-to-MIC from a clap and needs a
 * mic.wav this project does not produce (audio is deferred, STC-233/234).
 *
 * Usage: node scripts/measure-camera-sync.mjs <takeDir>
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { closeQuietly, bounded, EVAL_MS } from "./gate-bounds.mjs";

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, "camera.mp4"))) {
  console.error("usage: node scripts/measure-camera-sync.mjs <takeDir with camera.mp4>");
  process.exit(2);
}

/**
 * The lag that best aligns two luminance series, by cross-correlation.
 *
 * Edge-pairing was tried first and is WRONG here: it found 5 steps in the
 * display and 1 in the camera, then paired them by index and reported -1233 ms
 * — the camera seeing a flash before the screen showed it, which is not a
 * measurement, it is a bug with a decimal point. The camera's auto-exposure
 * ramps rather than steps, and a spurious step (a window appearing) shifts
 * every later pair.
 *
 * Correlation uses the WHOLE signal instead of chosen points, so it does not
 * care that the two tracks have different frame rates, different brightness
 * scales, or an extra transition in one of them. The reported peak is only
 * trustworthy if it stands above the rest of the curve, so that margin is
 * reported too rather than left for the reader to assume.
 */
function resample(series, stepNs, t0, t1) {
  const out = [];
  let i = 0;
  for (let t = t0; t <= t1; t += stepNs) {
    while (i + 1 < series.length && series[i + 1].ptsNs <= t) i++;
    out.push(series[i].luma);
  }
  return out;
}

function zscore(a) {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
  return a.map((v) => (v - m) / sd);
}

function bestLag(display, camera, stepNs, maxLagNs) {
  const t0 = Math.max(display[0].ptsNs, camera[0].ptsNs) + maxLagNs;
  const t1 = Math.min(display[display.length - 1].ptsNs, camera[camera.length - 1].ptsNs) - maxLagNs;
  if (t1 <= t0) return null;
  const d = zscore(resample(display, stepNs, t0, t1));
  const steps = Math.round(maxLagNs / stepNs);
  const scored = [];
  for (let k = -steps; k <= steps; k++) {
    const c = zscore(resample(camera, stepNs, t0 + k * stepNs, t1 + k * stepNs));
    const n = Math.min(d.length, c.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * c[i];
    scored.push({ lagNs: k * stepNs, r: sum / n });
  }
  scored.sort((a, b) => b.r - a.r);
  const peak = scored[0];
  // How far the peak stands above everything not adjacent to it. A peak that
  // barely clears the rest is noise wearing a number's clothes.
  const far = scored.filter((s) => Math.abs(s.lagNs - peak.lagNs) > 200e6);
  const runnerUp = far.length ? far[0].r : 0;
  return { lagNs: peak.lagNs, r: peak.r, margin: peak.r - runnerUp };
}

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{ name: "take", configureServer(s) {
    s.middlewares.use("/take", (req, res, next) => {
      const n = (req.url || "").split("?")[0].replace(/^\//, "");
      if (!["display.mp4", "camera.mp4"].includes(n)) return next();
      res.setHeader("content-type", "video/mp4");
      res.end(readFileSync(join(dir, n)));
    });
  }}],
});
await server.listen(5217);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page:", String(e)));
let code = 1;
try {
  await page.goto("http://localhost:5217/luma.html");
  await page.waitForFunction(() => window.__lumaReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__lumaReady === true, { timeout: 60_000 });

  const get = async (name) => {
    const r = await bounded(page.evaluate((u) => window.lumaSeries(u), `/take/${name}`),
                            EVAL_MS, `luma series for ${name}`);
    if (r.fatal) throw new Error(`${name}: ${r.fatal}`);
    return r.series;
  };
  const display = await get("display.mp4");
  const camera = await get("camera.mp4");

  const fps = (s) => (s.length < 2 ? 0 : 1e9 / ((s[s.length - 1].ptsNs - s[0].ptsNs) / (s.length - 1)));
  const range = (s) => [Math.min(...s.map((x) => x.luma)), Math.max(...s.map((x) => x.luma))];
  const [dlo, dhi] = range(display), [clo, chi] = range(camera);
  console.log(`display  ${display.length} frames, ${fps(display).toFixed(1)} fps, luma ${dlo.toFixed(1)}..${dhi.toFixed(1)}`);
  console.log(`camera   ${camera.length} frames, ${fps(camera).toFixed(1)} fps, luma ${clo.toFixed(1)}..${chi.toFixed(1)}`);

  // Without a flash there is no shared event and nothing to correlate. Say so
  // rather than reporting the lag of two noise floors.
  const MIN_SWING = 20;
  if (dhi - dlo < MIN_SWING || chi - clo < MIN_SWING) {
    console.log(`\nNO FLASH: luma swing is under ${MIN_SWING} in one track. ` +
                `Re-record while running scripts/_flash.tmp.mjs.`);
    code = 2;
  } else {
    const best = bestLag(display, camera, 5e6, 1000e6);
    const camIntervalMs = 1e3 / fps(camera);
    if (!best || best.margin < 0.15) {
      console.log(`\nNO CONFIDENT ALIGNMENT (peak r=${best?.r.toFixed(3)}, ` +
                  `margin ${best?.margin.toFixed(3)}). Not reporting a number.`);
      code = 2;
    } else {
      console.log(`\ncamera lags display by ${(best.lagNs / 1e6).toFixed(0)} ms ` +
                  `(correlation r=${best.r.toFixed(3)}, margin over unrelated lags ${best.margin.toFixed(3)})`);
      console.log(`resolution floor: camera frame interval ${camIntervalMs.toFixed(1)} ms; ` +
                  `correlation grid 5 ms`);
      code = 0;
    }
  }
} catch (e) {
  console.error("FAILED:", String(e?.stack ?? e));
} finally {
  await closeQuietly(browser, server);
}
process.exit(code);

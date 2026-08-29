/**
 * Full-screen flashes: the one physical event both tracks can see.
 *
 * The camera faces the user, not the screen, so it cannot see the display
 * directly — but a full-screen white flash changes the room and face
 * illumination enough to show up as a luminance step in camera.mp4, while
 * display.mp4 records it directly. That shared event is what
 * scripts/measure-camera-sync.mjs correlates.
 *
 * Run it WHILE a capture is running:
 *   ( open -W tools/test-host/STCTestHost.app --args ... --camera & )
 *   node scripts/flash-for-sync.mjs 4000
 *
 * The delay exists because the camera needs to warm up first — measured at
 * 1.7 s to first frame on a FaceTime HD, and over 2 s on a cold Elgato.
 */
import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: false,
  args: ["--start-fullscreen", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage();
await p.setContent(`<style>html,body{margin:0;height:100%;background:#000}</style><body>`);
const flash = async () => {
  await p.evaluate(() => { document.body.style.background = "#fff"; });
  await new Promise(r => setTimeout(r, 700));
  await p.evaluate(() => { document.body.style.background = "#000"; });
};
await new Promise(r => setTimeout(r, Number(process.argv[2] ?? 4000)));  // let the camera warm up
for (let i = 0; i < 4; i++) { await flash(); await new Promise(r => setTimeout(r, 2300)); }
await b.close();

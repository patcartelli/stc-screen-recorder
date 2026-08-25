import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { HelperSupervisor } from "./supervisor.js";
import { newTakeDir, takesRoot, listTakes } from "./takes.js";

/**
 * Electron main process. Owns the helper: it is spawned as a CHILD of this
 * process, which is what gives it this app's TCC identity — one grant, against
 * the signed bundle the user recognises, rather than a second opaque helper
 * appearing in System Settings (PHASE-0 §6, demonstrated in increment 2).
 */

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = join(here, "..", "..", "helper", "build", "stc-helper");

let win: BrowserWindow | undefined;
let sup: HelperSupervisor | undefined;
/** The take the renderer may currently read, set only by preview:open. */
let openTake: string | undefined;

// The renderer is sandboxed and cannot read files. It gets bytes over IPC and
// never names a path: it may ask for one of three fixed filenames, and only
// from the take the main process deliberately opened.
//
// A custom protocol was the first attempt and cannot work here — the window is
// loaded from file://, and Chromium refuses cross-origin fetches from a file
// origin to any non-http scheme. Serving the app itself over a custom scheme
// would fix that, but IPC removes the origin question altogether.
const TAKE_FILES = new Set(["anchors.json", "events.json", "display.mp4"]);

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520, height: 620, title: "stc recorder",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(join(here, "..", "renderer", "index.html"));
}

function startSupervisor(): void {
  sup = HelperSupervisor.start(HELPER, { statsIntervalMs: 500 });
  sup.on("ready", (l) => send("helper:ready", l));
  sup.on("stats", (l) => send("helper:stats", l));
  sup.on("respawned", (i) => send("helper:respawned", i));
  sup.on("gave-up", (i) => send("helper:gave-up", i));
  // The helper holds the capture devices: if it dies mid-recording the take is
  // gone, and that must be stated rather than left to look like an idle reset.
  sup.on("recording-lost", (i) => send("helper:recording-lost", i));
  // Stopped cleanly without being asked — the take is intact, unlike a loss.
  sup.on("recording-ended", (i) => send("helper:recording-ended", i));
  sup.on("helper:warning", (l) => send("helper:warning", l));
}

app.whenReady().then(() => {
  startSupervisor();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", async () => {
  await sup?.shutdown();
  if (process.platform !== "darwin") app.quit();
});

// Devices are released on a deliberate quit, not left to process teardown.
app.on("before-quit", async () => { await sup?.shutdown(); });

ipcMain.handle("recorder:status", async () => ({
  state: sup?.state ?? "starting",
  pid: sup?.pid,
}));

ipcMain.handle("recorder:start", async () => {
  if (!sup) throw new Error("supervisor not running");
  const root = takesRoot(process.env);
  const existing = existsSync(root) ? readdirSync(root) : [];
  // The helper creates the directory itself, and removes it again if the start
  // fails — so a denied grant leaves nothing behind on the user's Desktop.
  const dir = newTakeDir(process.env, new Date(), existing);
  try {
    const r = await sup.startRecording(dir);
    return { ok: true, dir, info: r };
  } catch (e: any) {
    // A missing Screen Recording grant is the common case and is actionable —
    // surface the helper's own code rather than a generic failure.
    return { ok: false, code: e?.code ?? "start-failed", detail: e?.detail ?? String(e?.message ?? e) };
  }
});

ipcMain.handle("recorder:stop", async () => {
  if (!sup) throw new Error("supervisor not running");
  const r = await sup.stopRecording();
  return { ok: true, info: r };
});

ipcMain.handle("recorder:takes", async () => listTakes(process.env));

ipcMain.handle("preview:open", async (_e, dir: string) => {
  const root = takesRoot(process.env);
  if (!dir.startsWith(root)) throw new Error("refusing to open a path outside the recordings folder");
  openTake = dir;
  return true;
});

ipcMain.handle("preview:close", async () => { openTake = undefined; });

ipcMain.handle("export:write", async (_e, name: string, bytes: ArrayBuffer) => {
  if (!openTake) throw new Error("no take is open");
  // The renderer chooses a filename; constrain it to a leaf name with a known
  // extension so it cannot traverse out of the take directory.
  if (!/^[A-Za-z0-9._-]+\.(mp4|json)$/.test(name) || name.includes("..")) {
    throw new Error(`refusing to write "${name}"`);
  }
  const dest = join(openTake, name);
  await writeFile(dest, Buffer.from(bytes));
  return dest;
});

ipcMain.handle("preview:read", async (_e, name: string) => {
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to read "${name}"`);
  const buf = await readFile(join(openTake, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle("recorder:reveal", async (_e, dir: string) => {
  // Only ever reveal something inside the recordings folder: `dir` arrives from
  // the renderer, and the renderer should not be able to open arbitrary paths.
  const root = takesRoot(process.env);
  if (!dir.startsWith(root)) throw new Error("refusing to reveal a path outside the recordings folder");
  shell.showItemInFolder(dir);
});
